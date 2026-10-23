// 音频采集工具：把麦克风采集为 16kHz 单声道 PCM16 的 base64，
// 供「声纹注册（录一段）」与「直播声纹鉴别（持续流）」复用。

const TARGET_SR = 16000;

function concat(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function resample(input: Float32Array, inSr: number, outSr: number): Float32Array {
  if (inSr === outSr) return input;
  const ratio = outSr / inSr;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i / ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, input.length - 1);
    const f = idx - lo;
    out[i] = input[lo] * (1 - f) + input[hi] * f;
  }
  return out;
}

export function pcm16ToBase64(float32: Float32Array): string {
  const n = float32.length;
  const buf = new ArrayBuffer(n * 2);
  const view = new DataView(buf);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private rawBuf: Float32Array[] = [];
  private inputSr = TARGET_SR;
  private emitMs = 1000;
  private emitTimer: number | null = null;
  private onChunk: ((b64: string, sr: number) => void) | null = null;

  /** 开始持续采集，每隔 emitMs 回调一段 16k PCM16 base64（用于直播声纹鉴别）。 */
  async start(onChunk: (b64: string, sr: number) => void, emitMs = 1000): Promise<void> {
    this.onChunk = onChunk;
    this.emitMs = emitMs;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    this.ctx = new AudioContext();
    this.inputSr = this.ctx.sampleRate;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => {
      this.rawBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
    this.emitTimer = window.setInterval(() => this.flush(), this.emitMs);
  }

  private flush(): void {
    if (!this.rawBuf.length || !this.onChunk) return;
    const raw = concat(this.rawBuf);
    this.rawBuf = [];
    const resampled = resample(raw, this.inputSr, TARGET_SR);
    this.onChunk(pcm16ToBase64(resampled), TARGET_SR);
  }

  /** 录制固定时长，返回整段 16k PCM16 base64（用于声纹注册）。 */
  async recordOnce(seconds: number): Promise<{ b64: string; sr: number }> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const frames: Float32Array[] = [];
    proc.onaudioprocess = (e) => frames.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    src.disconnect();
    proc.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    const raw = concat(frames);
    const res = resample(raw, ctx.sampleRate, TARGET_SR);
    return { b64: pcm16ToBase64(res), sr: TARGET_SR };
  }

  stop(): void {
    if (this.emitTimer !== null) clearInterval(this.emitTimer);
    this.emitTimer = null;
    try {
      this.proc?.disconnect();
      this.src?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.proc = null;
    this.src = null;
    this.rawBuf = [];
  }
}
