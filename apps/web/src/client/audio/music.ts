interface Note {
	at: number;
	duration: number;
	midi: number;
	shape: "sine" | "triangle";
	level: number;
}

export function musicPlan(night: boolean, random: () => number) {
	const duration = 60 + random() * 120;
	const silence = 120 + random() * 180;
	const beat = night ? 1.08 : 0.77;
	const scale = night ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
	const root = night ? 48 : 55;
	const notes: Note[] = [];
	// Repeat a four-note motif across the two halves of each phrase and vary its ending.
	for (let at = 0; at + 8 * beat <= duration - 2; at += 8 * beat) {
		const motif = Array.from({ length: 4 }, () => Math.floor(random() * scale.length));
		const harmony = Math.floor(random() * 3);
		notes.push({ at, duration: 6 * beat, midi: root - 12 + scale[harmony], shape: "sine", level: 0.13 });
		for (const [index, offset] of [0, 1, 2.5, 3.5, 4.5, 5.5, 7].entries()) {
			const degree = index === 6 ? harmony : motif[index % motif.length];
			notes.push({
				at: at + offset * beat, duration: 1.6 * beat, midi: root + 12 + scale[degree],
				shape: index % 3 === 0 ? "triangle" : "sine", level: 0.09,
			});
		}
	}
	notes.push({ at: duration - 2.5, duration: 1.7, midi: root, shape: "sine", level: 0.11 });
	return { duration, silence, beat, notes };
}

export function createMusic(context: AudioContext, output: AudioNode) {
	const bus = context.createGain();
	const echo = context.createDelay();
	const feedback = context.createGain();
	echo.delayTime.value = 0.31;
	feedback.gain.value = 0.24;
	bus.connect(output);
	bus.connect(echo).connect(feedback);
	feedback.connect(echo);
	feedback.connect(output);

	const voices = new Map<OscillatorNode, GainNode>();
	function note(note: Note, start: number) {
		const osc = context.createOscillator();
		const gain = context.createGain();
		const end = start + note.duration;
		osc.type = note.shape;
		osc.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(note.level, start + Math.min(0.65, note.duration * 0.4));
		gain.gain.linearRampToValueAtTime(0, end);
		osc.connect(gain).connect(bus);
		osc.onended = () => {
			osc.disconnect();
			gain.disconnect();
			voices.delete(osc);
		};
		osc.start(start);
		osc.stop(end);
		voices.set(osc, gain);
	}
	function stop() {
		bus.disconnect();
		echo.disconnect();
		feedback.disconnect();
		for (const [osc, gain] of voices) {
			osc.onended = null;
			osc.stop();
			osc.disconnect();
			gain.disconnect();
		}
		voices.clear();
	}
	return { note, stop };
}
