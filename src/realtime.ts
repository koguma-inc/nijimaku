// OpenAI Realtime（gpt-live-transcribe）の文字起こしセッション。
// 接続・session.update・append/commit・イベント変換・ローテーション・再接続を持つ。
import WebSocket, { type RawData } from "ws";
import type { Logger } from "./log.ts";

const URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const SAMPLE_RATE = 24000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const HOLD_MAX_BYTES = 2000 * BYTES_PER_MS;
const RETIRE_TIMEOUT_MS = 10000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const SESSION_UPDATE_EVENT_ID = "session_update";

export type RealtimeStatus = "unconfigured" | "connecting" | "ready" | "rotating" | "reconnecting" | "failed";

export type TranscriptionConfig = {
  delay: string;
  // 空なら送らない（自動判定）。空の配列とnullはAPIが拒否する
  languages: string[];
  prompt: string;
  keywords: string[];
};

export type RealtimeOptions = {
  apiKey: string;
  transcription: TranscriptionConfig;
  rotateMin: number;
};

export type RealtimeHandlers = {
  onPartial(itemId: string, text: string): void;
  onFinal(itemId: string, transcript: string): void;
  onCommitted(seq: number, itemId: string): void;
  // 接続が閉じてcompletedが来なくなったitem
  onDropped(itemIds: string[]): void;
  onStatus(status: RealtimeStatus, detail?: string): void;
  // updateTranscriptionで送ったsession.updateが拒否された（接続はそのまま使える）
  onUpdateRejected(eventId: string, message: string): void;
};

type Conn = {
  id: number;
  ws: WebSocket;
  startedAt: number;
  ready: boolean;
  // こちらから閉じた接続。closeを予期しない切断として扱わない
  closing: boolean;
  // サーバーの100ms下限は前回のcommit以降のバッファで判定されるため、接続ごとに数える
  appendedBytes: number;
  // committedにはclientのevent_idが入らないため、送ったcommitのseqを順に対応づける
  fifo: number[];
  // completed待ちのseq。ローテーションで旧接続を閉じる条件
  outstanding: Set<number>;
  seqByItem: Map<string, number>;
  partials: Map<string, string>;
  retireTimer?: NodeJS.Timeout;
};

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  usage?: unknown;
  error?: { message?: string; event_id?: string | null } & Record<string, unknown>;
  session?: { id?: string; expires_at?: number };
};

export class RealtimeSession {
  #opts: RealtimeOptions;
  #handlers: RealtimeHandlers;
  #logger: Logger;
  #current: Conn | null = null;
  // ローテーションで並行して開いた次の接続。ready後の最初のcommitの直後にcurrentへ切り替える
  #next: Conn | null = null;
  #retiring = new Set<Conn>();
  #connSeq = 0;
  #hold: Buffer[] = [];
  #holdBytes = 0;
  #droppedBytes = 0;
  #attempt = 0;
  #reconnectTimer?: NodeJS.Timeout;
  #rotateTimer?: NodeJS.Timeout;
  #status: RealtimeStatus = "connecting";
  #detail: string | undefined;
  #stopped = false;
  #failed = false;
  #updateSeq = 0;
  #openSocket: (apiKey: string) => WebSocket;

  constructor(
    opts: RealtimeOptions,
    handlers: RealtimeHandlers,
    logger: Logger,
    openSocket = (apiKey: string) => new WebSocket(URL, { headers: { Authorization: `Bearer ${apiKey}` } }),
  ) {
    this.#opts = opts;
    this.#handlers = handlers;
    this.#logger = logger;
    this.#openSocket = openSocket;
  }

  get status(): { state: RealtimeStatus; detail?: string } {
    return this.#detail === undefined ? { state: this.#status } : { state: this.#status, detail: this.#detail };
  }

  start(): void {
    if (!this.#opts.apiKey) {
      this.#setStatus("unconfigured", "設定画面でAPIキーを入力してください。");
      return;
    }
    this.#setStatus("connecting");
    this.#current = this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#closeAll("stop");
  }

  setApiKey(apiKey: string): void {
    if (apiKey === this.#opts.apiKey && !this.#failed) return;
    this.#stopped = true;
    this.#closeAll("api_key_changed");
    this.#current = this.#next = null;
    this.#retiring.clear();
    this.#hold = [];
    this.#holdBytes = this.#droppedBytes = this.#attempt = 0;
    this.#stopped = this.#failed = false;
    this.#opts.apiKey = apiKey;
    this.start();
  }

  // 送ったsession.updateのevent_idを返す。拒否されるとonUpdateRejectedにそのevent_idが届く。
  // 送り直しはせず、以後の接続（ローテーション・再接続）は新しい設定で張る
  updateTranscription(transcription: TranscriptionConfig): string[] {
    const delayChanged = transcription.delay !== this.#opts.transcription.delay;
    this.#opts.transcription = transcription;
    this.#logger.log("rt.session", { event: "update", ...transcription });
    if (this.#stopped) return [];
    // 設定ミスで止まっていたら、新しい設定で接続し直す
    if (this.#failed) {
      this.#failed = false;
      this.#attempt = 0;
      this.start();
      return [];
    }
    // delayは接続中に変えて効くか確かめていないため、新しい接続に張り替えて反映する
    if (delayChanged && this.#current?.ready && !this.#next) {
      this.#rotate();
      return [];
    }
    const sent: string[] = [];
    for (const conn of [this.#current, this.#next]) {
      if (!conn?.ready || conn.ws.readyState !== WebSocket.OPEN) continue;
      const eventId = `settings_${++this.#updateSeq}`;
      conn.ws.send(JSON.stringify({ type: "session.update", event_id: eventId, session: this.#sessionConfig() }));
      sent.push(eventId);
    }
    return sent;
  }

  // ready前（接続中・再接続待ち）は直近2秒ぶんだけ保持し、readyで送る
  append(pcm: Buffer): void {
    if (!this.#opts.apiKey) return;
    const conn = this.#current;
    if (conn?.ready && conn.ws.readyState === WebSocket.OPEN) {
      this.#sendAppend(conn, pcm);
      return;
    }
    this.#hold.push(pcm);
    this.#holdBytes += pcm.length;
    while (this.#holdBytes > HOLD_MAX_BYTES) {
      const dropped = this.#hold.shift()!;
      this.#holdBytes -= dropped.length;
      this.#droppedBytes += dropped.length;
    }
  }

  // 現在のappend先へ前回のcommit以降に送った音声の長さ。ready前に保持しているだけの音声は含めない
  appendedMsSinceCommit(): number {
    const conn = this.#current;
    return conn?.ready ? conn.appendedBytes / BYTES_PER_MS : 0;
  }

  // 呼び出し側（AudioPipeline.commit）がガードを済ませている前提。送った接続の番号を返す
  commit(seq: number): number | null {
    const conn = this.#current;
    if (!conn?.ready || conn.ws.readyState !== WebSocket.OPEN) return null;
    conn.ws.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: `commit_${seq}` }));
    conn.fifo.push(seq);
    conn.outstanding.add(seq);
    conn.appendedBytes = 0;
    if (this.#next?.ready) this.#switchToNext();
    return conn.id;
  }

  #connect(): Conn {
    const id = ++this.#connSeq;
    const ws = this.#openSocket(this.#opts.apiKey);
    const conn: Conn = {
      id,
      ws,
      startedAt: Date.now(),
      ready: false,
      closing: false,
      appendedBytes: 0,
      fifo: [],
      outstanding: new Set(),
      seqByItem: new Map(),
      partials: new Map(),
    };
    this.#log("rt.session", conn, { event: "connecting", delay: this.#opts.transcription.delay });

    ws.on("open", () => {
      if (conn.closing) return;
      this.#log("rt.session", conn, { event: "open" });
      ws.send(
        JSON.stringify({ type: "session.update", event_id: SESSION_UPDATE_EVENT_ID, session: this.#sessionConfig() }),
      );
    });
    ws.on("message", (raw) => this.#onMessage(conn, raw));
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      if (conn.closing) return;
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.#fail("OpenAIに接続できません。APIキーとアクセス権を確認してください。");
      } else {
        this.#log("rt.session", conn, { event: "error", message: `HTTP ${response.statusCode}` });
        ws.terminate();
      }
    });
    ws.on("error", (err) => this.#log("rt.session", conn, { event: "error", message: err.message }));
    ws.on("close", (code, reason) => this.#onClose(conn, code, reason.toString()));
    return conn;
  }

  // session.updateは差分でなく全体の置き換え（省いた項目はnullに戻る）なので、毎回すべて送る
  #sessionConfig(): Record<string, unknown> {
    const { delay, languages, prompt, keywords } = this.#opts.transcription;
    return {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription: {
            model: "gpt-live-transcribe",
            delay,
            ...(languages.length > 0 ? { languages } : {}),
            ...(prompt !== "" ? { prompt } : {}),
            ...(keywords.length > 0 ? { keywords } : {}),
          },
          // 省略するとserver_vadが入る
          turn_detection: null,
        },
      },
    };
  }

  #sendAppend(conn: Conn, pcm: Buffer): void {
    conn.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    conn.appendedBytes += pcm.length;
  }

  #onMessage(conn: Conn, raw: RawData): void {
    if (conn.closing) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw.toString()) as RealtimeEvent;
    } catch {
      return;
    }
    const itemId = event.item_id ?? "";
    switch (event.type) {
      case "session.created":
        this.#log("rt.session", conn, {
          event: "created",
          session_id: event.session?.id,
          expires_at: event.session?.expires_at,
        });
        break;
      case "session.updated":
        if (!conn.ready) this.#onReady(conn);
        else this.#log("rt.session", conn, { event: "updated" });
        break;
      case "input_audio_buffer.committed": {
        const seq = conn.fifo.shift();
        this.#log("rt.committed", conn, { seq: seq ?? null, item_id: itemId });
        if (seq === undefined) break;
        conn.seqByItem.set(itemId, seq);
        this.#handlers.onCommitted(seq, itemId);
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const text = (conn.partials.get(itemId) ?? "") + (event.delta ?? "");
        conn.partials.set(itemId, text);
        this.#log("rt.delta", conn, { item_id: itemId, delta: event.delta });
        // 先頭のdeltaに付くことがある半角スペースはtranscriptでは除かれている
        this.#handlers.onPartial(itemId, text.trimStart());
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        this.#log("rt.completed", conn, { item_id: itemId, transcript: event.transcript, usage: event.usage });
        conn.partials.delete(itemId);
        this.#settle(conn, itemId);
        this.#handlers.onFinal(itemId, event.transcript ?? "");
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.#log("rt.error", conn, { item_id: itemId, error: event.error });
        conn.partials.delete(itemId);
        this.#settle(conn, itemId);
        this.#handlers.onDropped([itemId]);
        break;
      case "error":
        this.#onError(conn, event);
        break;
    }
  }

  #onReady(conn: Conn): void {
    conn.ready = true;
    this.#attempt = 0;
    this.#log("rt.session", conn, { event: "ready", delay: this.#opts.transcription.delay });
    if (conn === this.#current) this.#activate(conn);
  }

  // currentになったready済みの接続で、保持していた音声を送り、ローテーションを予約する
  #activate(conn: Conn): void {
    for (const pcm of this.#hold) this.#sendAppend(conn, pcm);
    if (this.#droppedBytes > 0) {
      this.#log("rt.session", conn, { event: "audio_dropped", droppedMs: this.#droppedBytes / BYTES_PER_MS });
    }
    this.#hold = [];
    this.#holdBytes = 0;
    this.#droppedBytes = 0;
    this.#scheduleRotation(conn);
    this.#setStatus("ready");
  }

  #onError(conn: Conn, event: RealtimeEvent): void {
    const error: NonNullable<RealtimeEvent["error"]> = event.error ?? {};
    if (typeof error.event_id === "string" && error.event_id.startsWith("settings_")) {
      this.#log("rt.error", conn, { error });
      this.#handlers.onUpdateRejected(error.event_id, error.message ?? "session.updateが拒否されました");
      return;
    }
    const match = typeof error.event_id === "string" ? /^commit_(\d+)$/.exec(error.event_id) : null;
    if (match) {
      // エラーになったcommitにはcommittedもcompletedも来ない
      const seq = Number(match[1]);
      const index = conn.fifo.indexOf(seq);
      if (index !== -1) conn.fifo.splice(index, 1);
      conn.outstanding.delete(seq);
      this.#log("rt.error", conn, { seq, error });
      this.#closeIfRetired(conn);
      return;
    }
    this.#log("rt.error", conn, { error });
    // session.updatedの代わりにerrorが来たら設定ミスとみなし、再接続を繰り返さない
    if (!conn.ready && conn === this.#current) this.#fail(error.message ?? "session.updateが拒否されました");
    else if (!conn.ready && conn === this.#next) this.#close(conn, "rotate_failed");
  }

  #settle(conn: Conn, itemId: string): void {
    const seq = conn.seqByItem.get(itemId);
    if (seq !== undefined) {
      conn.outstanding.delete(seq);
      conn.seqByItem.delete(itemId);
    }
    this.#closeIfRetired(conn);
  }

  #scheduleRotation(conn: Conn): void {
    clearTimeout(this.#rotateTimer);
    const delay = Math.max(0, conn.startedAt + this.#opts.rotateMin * 60_000 - Date.now());
    this.#rotateTimer = setTimeout(() => this.#rotate(), delay);
  }

  #rotate(): void {
    if (this.#stopped || this.#failed || this.#next || !this.#current) return;
    const from = this.#current.id;
    this.#next = this.#connect();
    this.#log("rt.session", this.#next, { event: "rotate", from });
    this.#setStatus("rotating");
  }

  #switchToNext(): void {
    const old = this.#current!;
    const next = this.#next!;
    this.#next = null;
    this.#current = next;
    this.#log("rt.session", next, { event: "switch", from: old.id });
    this.#retire(old);
    this.#activate(next);
  }

  // 旧接続は未完了のcommitがすべてcompletedになるか、10秒経ったら閉じる
  #retire(conn: Conn): void {
    this.#retiring.add(conn);
    if (conn.outstanding.size === 0) {
      this.#close(conn, "retired");
      return;
    }
    conn.retireTimer = setTimeout(() => this.#close(conn, "retire_timeout"), RETIRE_TIMEOUT_MS);
  }

  #closeIfRetired(conn: Conn): void {
    if (this.#retiring.has(conn) && conn.outstanding.size === 0) this.#close(conn, "retired");
  }

  #close(conn: Conn, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    clearTimeout(conn.retireTimer);
    this.#log("rt.session", conn, { event: "closing", reason, outstanding: conn.outstanding.size });
    conn.ws.close(1000);
  }

  #onClose(conn: Conn, code: number, reason: string): void {
    clearTimeout(conn.retireTimer);
    this.#retiring.delete(conn);
    this.#log("rt.session", conn, { event: "close", code, reason, expected: conn.closing });
    const dropped = [...new Set([...conn.partials.keys(), ...conn.seqByItem.keys()])];
    conn.partials.clear();
    conn.seqByItem.clear();
    if (dropped.length > 0) this.#handlers.onDropped(dropped);
    if (this.#stopped || this.#failed) return;

    if (conn === this.#next) {
      this.#next = null;
      this.#setStatus(this.#current?.ready ? "ready" : this.#status);
      this.#scheduleRotationRetry();
      return;
    }
    if (conn !== this.#current) return;

    clearTimeout(this.#rotateTimer);
    this.#current = null;
    // 期限切れ等で現行が先に切れたら、ローテーション中の次の接続へそのまま移る
    const next = this.#next;
    if (next) {
      this.#next = null;
      this.#current = next;
      this.#log("rt.session", next, { event: "switch", from: conn.id });
      if (next.ready) this.#activate(next);
      else this.#setStatus("connecting");
      return;
    }
    this.#scheduleReconnect();
  }

  #backoff(): number {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt++;
    return delay;
  }

  #scheduleReconnect(): void {
    const delay = this.#backoff();
    this.#logger.log("rt.session", { event: "reconnect", delayMs: delay });
    this.#setStatus("reconnecting", `${Math.round(delay / 1000)}秒後に再接続`);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#stopped || this.#failed) return;
      this.#current = this.#connect();
    }, delay);
  }

  #scheduleRotationRetry(): void {
    clearTimeout(this.#rotateTimer);
    this.#rotateTimer = setTimeout(() => this.#rotate(), this.#backoff());
  }

  #fail(message: string): void {
    this.#failed = true;
    this.#logger.log("rt.session", { event: "failed", message });
    this.#setStatus("failed", message);
    this.#closeAll("failed");
  }

  #closeAll(reason: string): void {
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#rotateTimer);
    for (const conn of [this.#current, this.#next, ...this.#retiring]) {
      if (conn) this.#close(conn, reason);
    }
  }

  #setStatus(status: RealtimeStatus, detail?: string): void {
    if (status === this.#status && detail === this.#detail) return;
    this.#status = status;
    this.#detail = detail;
    this.#handlers.onStatus(status, detail);
  }

  #log(kind: string, conn: Conn, fields: Record<string, unknown>): void {
    this.#logger.log(kind, { conn: conn.id, ...fields });
  }
}
