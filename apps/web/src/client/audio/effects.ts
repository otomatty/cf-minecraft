import type { Material, Sound } from "./events.ts";

type Tone = [frequency: number, end: number, level: number, shape: OscillatorType];
type Noise = [frequency: number, level: number, filter: BiquadFilterType];
interface Timbre { duration: number; tone?: Tone; noise?: Noise }
type Voice = { stop(): void };

const materials: Record<Material, Timbre> = {
	stone: { duration: 0.16, tone: [340, 125, 0.13, "triangle"], noise: [1550, 0.34, "bandpass"] },
	wood: { duration: 0.15, tone: [245, 95, 0.28, "triangle"], noise: [660, 0.20, "bandpass"] },
	earth: { duration: 0.13, tone: [120, 70, 0.17, "sine"], noise: [590, 0.30, "lowpass"] },
	sand: { duration: 0.22, noise: [1230, 0.39, "bandpass"] },
	glass: { duration: 0.25, tone: [2330, 1690, 0.16, "sine"], noise: [3100, 0.28, "highpass"] },
	wool: { duration: 0.11, tone: [102, 56, 0.14, "sine"], noise: [310, 0.18, "lowpass"] },
	plant: { duration: 0.20, noise: [2450, 0.28, "bandpass"] },
	water: { duration: 0.23, tone: [270, 690, 0.13, "sine"], noise: [960, 0.29, "bandpass"] },
	lava: { duration: 0.29, tone: [125, 53, 0.23, "triangle"], noise: [330, 0.31, "lowpass"] },
};

// Cow, pig, chicken, sheep, zombie, skeleton, creeper in mirror kind order.
const mobs: readonly Timbre[] = [
	{ duration: 0.34, tone: [142, 102, 0.28, "triangle"], noise: [430, 0.16, "bandpass"] },
	{ duration: 0.23, tone: [420, 245, 0.23, "triangle"], noise: [850, 0.15, "bandpass"] },
	{ duration: 0.14, tone: [1050, 530, 0.25, "sine"], noise: [2350, 0.15, "bandpass"] },
	{ duration: 0.30, tone: [262, 200, 0.21, "sawtooth"], noise: [600, 0.16, "bandpass"] },
	{ duration: 0.39, tone: [81, 51, 0.22, "sawtooth"], noise: [330, 0.21, "bandpass"] },
	{ duration: 0.17, tone: [440, 170, 0.12, "triangle"], noise: [2430, 0.34, "bandpass"] },
	{ duration: 0.23, noise: [950, 0.35, "highpass"] },
];

type OtherSound = Exclude<Sound["kind"], "break" | "place" | "dig" | "step" | "mobHurt" | "mobDeath">;
const effects: Record<OtherSound, Timbre> = {
	playerHurt: { duration: 0.24, tone: [185, 77, 0.30, "triangle"], noise: [450, 0.25, "bandpass"] },
	eat: { duration: 0.23, tone: [169, 300, 0.18, "sine"], noise: [1430, 0.23, "bandpass"] },
	death: { duration: 0.64, tone: [115, 42, 0.39, "triangle"], noise: [600, 0.18, "lowpass"] },
	pickup: { duration: 0.14, tone: [610, 1030, 0.27, "sine"] },
	arrowShoot: { duration: 0.23, tone: [410, 105, 0.15, "triangle"], noise: [1920, 0.29, "bandpass"] },
	arrowStick: { duration: 0.12, tone: [290, 109, 0.19, "triangle"], noise: [920, 0.18, "bandpass"] },
	arrowHit: { duration: 0.20, tone: [163, 70, 0.23, "sine"], noise: [620, 0.30, "lowpass"] },
	fuse: { duration: 1.4, noise: [3400, 0.35, "highpass"] },
	explosion: { duration: 0.9, tone: [74, 32, 0.64, "sine"], noise: [280, 0.68, "lowpass"] },
	toolBreak: { duration: 0.21, tone: [720, 185, 0.24, "triangle"], noise: [2150, 0.43, "highpass"] },
	click: { duration: 0.055, tone: [850, 570, 0.13, "sine"] },
};

export function noiseBuffer(context: AudioContext): AudioBuffer {
	const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 2), context.sampleRate);
	const samples = buffer.getChannelData(0);
	for (let i = 0; i < samples.length; i++) samples[i] = 2 * Math.random() - 1;
	return buffer;
}

export function playEffect(context: AudioContext, destination: AudioNode, buffer: AudioBuffer,
	sound: Sound, gain: number, pan: number, onEnd: (voice: Voice) => void): Voice {
	const timbre = "material" in sound ? materials[sound.material]
		: "mob" in sound ? mobs[sound.mob] : effects[sound.kind];
	const emphasis = sound.kind === "dig" ? 0.44 : sound.kind === "step" ? 0.55 : sound.kind === "place" ? 0.82 : 1;
	const length = timbre.duration * (0.9 + Math.random() * 0.2) * (sound.kind === "mobDeath" ? 1.7 : 0.7 + emphasis * 0.3);
	const pitch = (0.91 + Math.random() * 0.18) * (sound.kind === "mobDeath" ? 0.72 : sound.kind === "place" ? 0.82 : 1);
	const start = context.currentTime;
	const end = start + length;
	const envelope = context.createGain();
	envelope.gain.setValueAtTime(0, start);
	envelope.gain.linearRampToValueAtTime(gain * emphasis, start + (sound.kind === "fuse" ? 0.075 : 0.008));
	envelope.gain.exponentialRampToValueAtTime(gain * emphasis * 0.0025, end);
	const nodes: AudioNode[] = [envelope];
	if (pan && typeof context.createStereoPanner === "function") {
		const stereo = context.createStereoPanner();
		stereo.pan.value = pan;
		envelope.connect(stereo).connect(destination);
		nodes.push(stereo);
	} else envelope.connect(destination);

	const sources: AudioScheduledSourceNode[] = [];
	let noiseSource: AudioBufferSourceNode | null = null;
	if (timbre.tone) {
		const [from, to, level, shape] = timbre.tone;
		const osc = context.createOscillator();
		const mix = context.createGain();
		mix.gain.value = level;
		osc.type = shape;
		osc.frequency.setValueAtTime(from * pitch, start);
		osc.frequency.exponentialRampToValueAtTime(to * pitch, end);
		osc.connect(mix).connect(envelope);
		sources.push(osc);
		nodes.push(osc, mix);
	}
	if (timbre.noise) {
		const [frequency, level, type] = timbre.noise;
		const noise = noiseSource = context.createBufferSource();
		const filter = context.createBiquadFilter();
		const mix = context.createGain();
		noise.buffer = buffer;
		mix.gain.value = level;
		filter.type = type;
		filter.frequency.value = frequency * pitch;
		noise.connect(filter).connect(mix).connect(envelope);
		sources.push(noise);
		nodes.push(noise, filter, mix);
	}

	let stopped = false;
	function disconnect() {
		stopped = true;
		sources[0].onended = null;
		for (const node of nodes) node.disconnect();
		onEnd(voice);
	}
	const voice = {
		stop() {
			if (stopped) return;
			for (const source of sources) source.stop();
			disconnect();
		},
	};
	try {
		for (const source of sources) {
			if (noiseSource && source === noiseSource) noiseSource.start(start, Math.random() * (buffer.duration - length));
			else source.start(start);
			source.stop(end);
		}
		sources[0].onended = disconnect;
		return voice;
	} catch (error) {
		for (const source of sources) {
			try { source.stop(); } catch { /* This source may not have started. */ }
		}
		for (const node of nodes) node.disconnect();
		throw error;
	}
}
