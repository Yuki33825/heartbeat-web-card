/**
 * HapticPulseSynth — 物理振動特化型シンセ・エンジン
 *
 * Sawtooth波の豊かな倍音構造 + ソフトクリッピング + 高速バーストパターンで
 * iPhoneスピーカーのコーンを最大変位させ、筐体を物理的に振動させる。
 *
 * SFC x-Music Lab / Brain-muscle Haptic Audio
 */
import * as Tone from "tone";

// ── ユーザー固有バリエーション型 ──
interface UserVariation {
  freqOffset: number;
  filterOffset: number;
  filterQ: number;
  subFreqOffset: number;
}

// ── mulberry32 擬似乱数生成器 ──
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 定数 ──
const BASE_FREQ = 40;
const SUB_FREQ = 20;
const FILTER_BASE = 150;
const FILTER_TOUCH_OPEN = 250;
const MASTER_GAIN = 1.0;
const TOUCH_BOOST_GAIN = 2.0;
const SEED_KEY = "haptic_pulse_seed";

// バーストパターン設定
const BURST_COUNT = 8;
const BURST_INTERVAL = 0.06;     // 60ms間隔
const BURST_DECAY = 0.04;        // 各パルス 40ms decay
const BURST_GAIN_FALLOFF = 0.88; // パルスごとのゲイン減衰率

// tanh飽和カーブ生成
function makeSaturationCurve(amount: number): Float32Array {
  const samples = 8192;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

export class HapticPulseSynth {
  private _ready = false;
  private _variation: UserVariation;

  private _osc: Tone.Oscillator | null = null;
  private _subOsc: Tone.Oscillator | null = null;
  private _subSineOsc: Tone.Oscillator | null = null;
  private _ampEnv: Tone.AmplitudeEnvelope | null = null;
  private _subEnv: Tone.AmplitudeEnvelope | null = null;
  private _filter: Tone.BiquadFilter | null = null;
  private _saturator: Tone.WaveShaper | null = null;
  private _burstGain: Tone.Gain | null = null;
  private _touchBoostGain: Tone.Gain | null = null;
  private _masterGain: Tone.Gain | null = null;

  constructor() {
    const seed = this._loadOrCreateSeed();
    this._variation = this._computeVariation(seed);
  }

  async init(): Promise<void> {
    await Tone.start();
    this._buildSynthChain();
    this._ready = true;
    console.log(
      "[HapticPulseSynth] initialized — freq:",
      (BASE_FREQ + this._variation.freqOffset).toFixed(1) + "Hz",
      "filter:", (FILTER_BASE + this._variation.filterOffset).toFixed(0) + "Hz",
      "Q:", this._variation.filterQ.toFixed(1)
    );
  }

  private _buildSynthChain(): void {
    const v = this._variation;

    // ── オシレーター ──
    this._osc = new Tone.Oscillator({
      type: "sawtooth",
      frequency: BASE_FREQ + v.freqOffset,
    });

    this._subOsc = new Tone.Oscillator({
      type: "square",
      frequency: SUB_FREQ + v.subFreqOffset,
    });

    this._subSineOsc = new Tone.Oscillator({
      type: "sine",
      frequency: SUB_FREQ + v.subFreqOffset,
    });

    // ── エンベロープ ──
    this._ampEnv = new Tone.AmplitudeEnvelope({
      attack: 0.003,
      decay: BURST_DECAY,
      sustain: 0,
      release: 0.02,
    });

    this._subEnv = new Tone.AmplitudeEnvelope({
      attack: 0.003,
      decay: BURST_DECAY + 0.01,
      sustain: 0,
      release: 0.02,
    });

    // ── フィルター ──
    this._filter = new Tone.BiquadFilter({
      type: "lowpass",
      frequency: FILTER_BASE + v.filterOffset,
      Q: v.filterQ,
    });

    // ── WaveShaper: tanh飽和でRMSを最大化 ──
    this._saturator = new Tone.WaveShaper(makeSaturationCurve(3));

    // ── ゲインステージ ──
    this._burstGain = new Tone.Gain(1.0);
    this._touchBoostGain = new Tone.Gain(1.0);
    this._masterGain = new Tone.Gain(MASTER_GAIN);

    // ── 接続 ──
    // Saw → AmpEnv → Filter
    this._osc.connect(this._ampEnv);
    this._ampEnv.connect(this._filter);

    // Sub Square + Sub Sine → SubEnv → Filter
    this._subOsc.connect(this._subEnv);
    this._subSineOsc.connect(this._subEnv);
    this._subEnv.connect(this._filter);

    // Filter → Saturator → BurstGain → TouchBoost → Master → Out
    this._filter.chain(
      this._saturator,
      this._burstGain,
      this._touchBoostGain,
      this._masterGain,
      Tone.getDestination()
    );

    // オシレーター常時稼働
    this._osc.start();
    this._subOsc.start();
    this._subSineOsc.start();
  }

  /**
   * 心拍トリガー: 高速バーストパターン（ドドドドッ）
   * 8発の短パルスを60ms間隔で連打し、ゲインを徐々に減衰。
   */
  trigger(): void {
    if (!this._ready || !this._ampEnv || !this._subEnv || !this._burstGain) return;

    const now = Tone.now();

    for (let i = 0; i < BURST_COUNT; i++) {
      const t = now + i * BURST_INTERVAL;
      const gain = Math.pow(BURST_GAIN_FALLOFF, i);

      // バーストゲインをスケジュール
      this._burstGain.gain.setValueAtTime(gain, t);

      // エンベロープをトリガー
      this._ampEnv.triggerAttackRelease(BURST_DECAY, t);
      this._subEnv.triggerAttackRelease(BURST_DECAY + 0.01, t);
    }
  }

  setTouchBoost(active: boolean): void {
    if (!this._ready || !this._touchBoostGain || !this._filter) return;

    this._touchBoostGain.gain.rampTo(active ? TOUCH_BOOST_GAIN : 1.0, 0.1);
    this._filter.frequency.rampTo(
      active ? FILTER_TOUCH_OPEN : FILTER_BASE + this._variation.filterOffset,
      0.15
    );
  }

  getAudioContext(): AudioContext {
    return Tone.getContext().rawContext as AudioContext;
  }

  dispose(): void {
    this._osc?.dispose();
    this._subOsc?.dispose();
    this._subSineOsc?.dispose();
    this._ampEnv?.dispose();
    this._subEnv?.dispose();
    this._filter?.dispose();
    this._saturator?.dispose();
    this._burstGain?.dispose();
    this._touchBoostGain?.dispose();
    this._masterGain?.dispose();
    this._ready = false;
  }

  private _loadOrCreateSeed(): number {
    const stored = localStorage.getItem(SEED_KEY);
    if (stored) return parseInt(stored, 10);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    localStorage.setItem(SEED_KEY, seed.toString());
    return seed;
  }

  private _computeVariation(seed: number): UserVariation {
    const rng = mulberry32(seed);
    return {
      freqOffset: (rng() - 0.5) * 10,
      filterOffset: (rng() - 0.5) * 40,
      filterQ: 2 + rng() * 6,
      subFreqOffset: (rng() - 0.5) * 4,
    };
  }
}
