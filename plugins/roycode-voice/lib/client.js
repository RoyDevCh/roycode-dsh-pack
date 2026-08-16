window.__ModuleLoader__.load({
	id: "roycode-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region roycode-voice
		/** Dictionary namespace owned by this plugin. */
		const NS = "conversation.roycodeVoice";
		/** Services required by the composer block registration. */
		const inject = [
			"slots",
			"sessions",
			"conversation",
			"locale"
		];
		/** roycode-triggers host endpoint (must match its config.port). */
		const TRIGGERS_BASE = "http://127.0.0.1:8787";
		/** Hard cap on one recording (ms). */
		const MAX_RECORD_MS = 30000;
		/** Silence (ms) that ends a segment and transcribes it live. */
		const SILENCE_MS = 800;
		/** RMS below this counts as silence (0..1). */
		const RMS_THRESHOLD = 0.015;
		/** Minimum segment length before silence can cut it (avoids noise blips). */
		const MIN_SEGMENT_MS = 500;
		/** Level polling interval. */
		const LEVEL_INTERVAL_MS = 100;

		const zh = {
			mic: "语音输入",
			recording: "录音中，说话自动分段；再点停止",
			transcribing: "转写中…",
			error: "失败"
		};
		const en = {
			mic: "Voice input",
			recording: "Recording - segments auto-split on silence; tap to stop",
			transcribing: "Transcribing…",
			error: "Failed"
		};

		/** Mic button in the composer tool row: record -> live segment transcribe -> input draft. */
		function VoiceButton({ setDraft, currentDraft, t }) {
			const [phase, setPhase] = react.useState("idle");
			const [msg, setMsg] = react.useState("");
			const [live, setLive] = react.useState(0);
			const streamRef = react.useRef(null);
			const audioRef = react.useRef(null);
			const analyserRef = react.useRef(null);
			const levelTimerRef = react.useRef(null);
			const silenceRef = react.useRef(0);
			const segStartRef = react.useRef(0);
			const recRef = react.useRef(null);
			const chunksRef = react.useRef([]);
			const stoppingRef = react.useRef(false);
			const queueRef = react.useRef(Promise.resolve());

			// Serialize transcriptions so draft appends stay in order.
			const enqueue = (blob) => {
				queueRef.current = queueRef.current.then(async () => {
					try {
						const res = await fetch(TRIGGERS_BASE + "/voice/transcribe", {
							method: "POST",
							headers: { "content-type": blob.type || "audio/webm" },
							body: blob
						});
						const data = await res.json();
						if (!data.ok || !data.transcript) return;
						const prev = currentDraft().trim();
						const next = prev ? prev + "\n" + data.transcript : data.transcript;
						setDraft(next);
						setMsg("✓ " + data.transcript.slice(0, 50) + (data.transcript.length > 50 ? "…" : ""));
					} catch (e) {
						setMsg(t("error") + ": " + String((e && e.message) || e));
					}
				});
				return queueRef.current;
			};

			const endSegment = () => {
				if (recRef.current && recRef.current.state !== "inactive") {
					try { recRef.current.stop() } catch {}
				}
			};

			const beginSegment = () => {
				chunksRef.current = [];
				segStartRef.current = Date.now();
				silenceRef.current = 0;
				const rec = new MediaRecorder(streamRef.current);
				rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
				rec.onstop = () => {
					const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
					if (blob.size > 0) {
						setLive((n) => n + 1);
						enqueue(blob).finally(() => setLive((n) => Math.max(0, n - 1)));
					}
					if (!stoppingRef.current) beginSegment();
				};
				rec.onerror = () => { setPhase("error"); setMsg(t("error")); };
				recRef.current = rec;
				rec.start();
			};

			const levelLoop = () => {
				const analyser = analyserRef.current;
				if (!analyser) return;
				const data = new Uint8Array(analyser.fftSize);
				analyser.getByteTimeDomainData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i++) {
					const v = (data[i] - 128) / 128;
					sum += v * v;
				}
				const rms = Math.sqrt(sum / data.length);
				const now = Date.now();
				if (rms < RMS_THRESHOLD) {
					silenceRef.current += LEVEL_INTERVAL_MS;
					if (silenceRef.current >= SILENCE_MS && now - segStartRef.current >= MIN_SEGMENT_MS) {
						// Auto-split: end this segment, transcribe it, keep recording.
						endSegment();
					}
				} else {
					silenceRef.current = 0;
				}
			};

			const start = async () => {
				setMsg("");
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					streamRef.current = stream;
					const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
					audioRef.current = audioCtx;
					const source = audioCtx.createMediaStreamSource(stream);
					const analyser = audioCtx.createAnalyser();
					analyser.fftSize = 2048;
					source.connect(analyser);
					analyserRef.current = analyser;
					stoppingRef.current = false;
					beginSegment();
					levelTimerRef.current = setInterval(levelLoop, LEVEL_INTERVAL_MS);
					setPhase("recording");
				} catch (e) {
					setPhase("error");
					setMsg(t("error") + ": " + String((e && e.message) || e));
				}
			};

			const stop = () => {
				stoppingRef.current = true;
				if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
				endSegment();
				if (audioRef.current) { try { audioRef.current.close() } catch {} audioRef.current = null; }
				if (streamRef.current) { streamRef.current.getTracks().forEach((tr) => { try { tr.stop() } catch {} }); streamRef.current = null; }
				setPhase("idle");
			};

			const onClick = () => { if (phase === "recording") stop(); else start(); };
			const recording = phase === "recording";
			const busy = live > 0;
			return react.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
				react.createElement("button", {
					type: "button",
					title: t("mic"),
					"aria-label": t("mic"),
					onClick,
					disabled: phase === "transcribing",
					style: {
						minWidth: 28,
						height: 28,
						borderRadius: 8,
						border: "1px solid var(--dsw-alias-border-l2, #aaa)",
						background: recording ? "#e5534b" : "transparent",
						color: recording ? "#fff" : "inherit",
						cursor: "pointer",
						fontSize: 14,
						padding: "0 6px"
					}
				}, recording ? "●" : "🎤"),
				msg ? react.createElement("span", { style: { fontSize: 11, opacity: 0.8, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, msg) : null,
				busy ? react.createElement("span", { style: { fontSize: 11, opacity: 0.7 } }, t("transcribing")) : null
			);
		}

		/** Register the mic button in the composer tool row (right end, near send). */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "roycode-voice: dictionaries");
			ctx.inject([
				"slots",
				"sessions",
				"conversation",
				"locale"
			], (scope) => {
				const t = scope.locale.bind(NS);
				scope.slots.inject("conversation.input.right", () => scope.slots.register({
					name: "conversation.input.right",
					id: "roycode-voice",
					order: 10,
					locale: NS,
					inject: (sessionId) => {
						const actx = scope.sessions.scope(sessionId);
						if (actx === undefined) throw new Error("roycode-voice: session scope missing for " + String(sessionId));
						const conversation = actx.get("conversation");
						if (conversation === undefined) throw new Error("roycode-voice: conversation service missing on session scope");
						const input = conversation.input.for(actx);
						return {
							setDraft: (text) => input.actions.setDraft(text),
							currentDraft: () => input.snapshot?.draft ?? ""
						};
					}
				}, VoiceButton));
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
