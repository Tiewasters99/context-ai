// Downsamples 48kHz Float32 mono → 16kHz Int16 PCM and posts ArrayBuffer chunks.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.acc = 0;
    this.buffer = [];
    this.flushSize = 1600; // ~100ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    for (let i = 0; i < channel.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        let s = channel[i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }

    while (this.buffer.length >= this.flushSize) {
      const chunk = this.buffer.splice(0, this.flushSize);
      const pcm = new Int16Array(chunk);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
