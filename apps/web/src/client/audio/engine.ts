import { DEFAULT_VOLUMES, distanceGain, soundGain, spatialSound, voicesToStop, type Sound, type Volumes } from "./events.ts";
import { noiseBuffer, playEffect } from "./effects.ts";
import { createMusic, musicPlan } from "./music.ts";
import { celestialAngle } from "../sky.ts";
import type { Vec3 } from "../math.ts";

interface Graph {
	context: AudioContext;
	output: GainNode;
	effects: GainNode;
	music: GainNode;
	noise: AudioBuffer;
}
interface Track {
	plan: ReturnType<typeof musicPlan>;
	graph: ReturnType<typeof createMusic>;
	start: number;
	nextNote: number;
}

export class GameAudio {
	private graph: Graph | null = null;
	private unavailable = typeof globalThis.AudioContext !== "function";
	private visible = true;
	private resuming: Promise<void> | null = null;
	private volumes: Volumes = { ...DEFAULT_VOLUMES };
	private voices = new Set<ReturnType<typeof playEffect>>();
	private counts: Partial<Record<Sound["kind"], number>> = {};
	private track: Track | null = null;
	private nextTrack = 0;
	private camera: { x: number; y: number; z: number; yaw: number };

	constructor(camera: GameAudio["camera"]) {
		this.camera = camera;
	}

	/** Call directly from a trusted user gesture. */
	activate(click: boolean): void {
		if (!this.visible || this.unavailable) return;
		try {
			if (!this.graph) {
				const context = new AudioContext();
				try {
					const output = context.createGain();
					const effects = context.createGain();
					const music = context.createGain();
					const noise = noiseBuffer(context);
					effects.connect(output);
					music.connect(output);
					output.connect(context.destination);
					this.graph = { context, output, effects, music, noise };
					this.updateVolumes(this.volumes);
				} catch (error) {
					void context.close().catch(() => {});
					throw error;
				}
			}
			if (this.graph.context.state === "running") {
				if (click) this.play({ kind: "click" });
			} else {
				const resumed = this.resume();
				if (click) void resumed?.then(() => this.play({ kind: "click" }));
			}
		} catch {
			this.disable();
		}
	}

	private resume(): Promise<void> | null {
		const graph = this.graph;
		if (!graph || this.unavailable) return null;
		if (this.resuming) return this.resuming;
		try {
			const request = graph.context.resume().catch(() => {
				if (this.resuming === request) this.disable();
			}).finally(() => {
				if (this.resuming === request) this.resuming = null;
			});
			this.resuming = request;
			return request;
		} catch {
			this.disable();
			return null;
		}
	}

	setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		const graph = this.graph;
		if (!graph || this.unavailable) return;
		try {
			graph.output.gain.value = visible ? 1 : 0;
			if (visible) {
				// Queue a new resume after any suspend already requested by pagehide.
				this.resuming = null;
				void this.resume();
			} else {
				for (const voice of this.voices) voice.stop();
				void graph.context.suspend().catch(() => {
					if (graph.context.state === "closed") this.disable();
				});
			}
		} catch {
			this.disable();
		}
	}

	updateVolumes(volumes: Volumes): void {
		this.volumes = { ...volumes };
		if (!this.graph || this.unavailable) return;
		try {
			this.graph.effects.gain.value = soundGain(volumes, "effects");
			this.graph.music.gain.value = soundGain(volumes, "music");
			if (this.graph.music.gain.value === 0) {
				this.stopTrack();
				this.nextTrack = 0;
			}
		} catch {
			this.disable();
		}
	}

	play(sound: Sound, source?: Vec3): void {
		const graph = this.graph;
		if (!graph || this.state() !== "running" || graph.effects.gain.value === 0) return;
		const { distance, pan } = source ? spatialSound(this.camera, source) : { distance: 0, pan: 0 };
		const gain = distanceGain(distance);
		if (gain === 0) return;
		try {
			let remaining = voicesToStop(this.voices.size);
			for (const voice of this.voices) {
				if (remaining-- <= 0) break;
				voice.stop();
			}
			const voice = playEffect(graph.context, graph.effects, graph.noise, sound, gain, pan, ended => this.voices.delete(ended));
			this.voices.add(voice);
			this.counts[sound.kind] = (this.counts[sound.kind] ?? 0) + 1;
		} catch {
			this.disable();
		}
	}

	updateMusic(dayTime: number): void {
		const graph = this.graph;
		if (!graph || this.state() !== "running" || graph.music.gain.value === 0) return;
		const now = graph.context.currentTime;
		try {
			if (this.track && now >= this.track.start + this.track.plan.duration) this.stopTrack();
			if (!this.track && now >= this.nextTrack) {
				const plan = musicPlan(Math.cos(celestialAngle(dayTime) * 2 * Math.PI) < 0, Math.random);
				const start = now + 0.06;
				this.track = { plan, graph: createMusic(graph.context, graph.music), start, nextNote: 0 };
				this.nextTrack = start + plan.duration + plan.silence;
			}
			const track = this.track;
			if (!track) return;
			while (track.nextNote < track.plan.notes.length) {
				const note = track.plan.notes[track.nextNote];
				const start = track.start + note.at;
				if (start > now + 0.25) break;
				track.nextNote++;
				if (start >= now - 0.05) track.graph.note(note, Math.max(start, now));
			}
		} catch {
			this.disable();
		}
	}

	stats() {
		const state = this.state();
		return { state, counts: { ...this.counts }, bgm: state === "running" && this.track !== null };
	}

	private state(): "running" | "suspended" | "unavailable" {
		if (this.unavailable || this.graph?.context.state === "closed") return "unavailable";
		return this.visible && this.graph?.context.state === "running" ? "running" : "suspended";
	}

	private stopTrack(): void {
		this.track?.graph.stop();
		this.track = null;
	}

	private disable(): void {
		this.unavailable = true;
		const graph = this.graph;
		this.graph = null;
		if (!graph) return;
		try { graph.output.disconnect(); } catch { /* Output is already unavailable. */ }
		try { this.stopTrack(); } catch { /* Closing the context also stops its sources. */ }
		this.track = null;
		this.voices.clear();
		try { void graph.context.close().catch(() => {}); } catch { /* Audio is already disabled. */ }
	}
}
