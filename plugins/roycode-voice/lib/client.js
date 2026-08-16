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
		/** PCM chunk duration sent per request (ms). */
		const CHUNK_MS = 200;
		/** Silence (ms) that commits the current partial and starts a new segment. */
		const COMMIT_SILENCE_MS = 1100;
		/** RMS below this counts as silence (0..1). */
		const RMS_THRESHOLD = 0.02;
		/** Minimum segment length before silence can commit it. */
		const MIN_SEGMENT_MS = 600;
		const SAMPLE_RATE = 16000;

		const zh = {
			mic: "语音输入",
			recording: "录音中，实时转写；再点停止",
			transcribing: "转写中…",
			error: "失败"
		};
		const en = {
			mic: "Voice input",
			recording: "Recording - live transcription; tap to stop",
			transcribing: "Transcribing…",
			error: "Failed"
		};

		/** Mic button with live streaming transcription into the input draft. */
		function VoiceButton({ setDraft, currentDraft, t }) {
			const [phase, setPhase] = react.useState("idle");
			const [msg, setMsg] = react.useState("");
			const streamRef = react.useRef(null);
			const audioCtxRef = react.useRef(null);
			const processorRef = react.useRef(null);
			const sourceRef = react.useRef(null);
			const sidRef = react.useRef(null);
			const pcmBufRef = react.useRef([]);      // Float32 samples awaiting send
			const committedRef = react.useRef("");    // finalized text of current/prev segments
			const timerRef = react.useRef(null);
			const silenceRef = react.useRef(0);
			const segStartRef = react.useRef(0);
			const stoppingRef = react.useRef(false);
			const runningRef = react.useRef(false);

			// ---- host round trips ----
			const hostPost = async (path, body, headers) => {
				const res = await fetch(TRIGGERS_BASE + path, {
					method: "POST",
					headers: { "content-type": "application/json", ...(headers || {}) },
					body
				});
				return res.json();
			};

			const openStream = async () => {
				const sid = "rv-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
				const data = await hostPost("/voice/stream/open", JSON.stringify({ sid }));
				if (!data.ok) throw new Error(data.error || "open failed");
				sidRef.current = sid;
				return sid;
			};

			const sendChunk = async (sid, pcmInt16) => {
				const res = await fetch(TRIGGERS_BASE + "/voice/stream/audio", {
					method: "POST",
					headers: { "content-type": "application/octet-stream", "x-stream-id": sid },
					body: pcmInt16
				});
				return res.json();
			};

			const finalizeStream = async (sid) => hostPost("/voice/stream/finalize", JSON.stringify({ sid }));
			const abortStream = async (sid) => { try { await hostPost("/voice/stream/abort", JSON.stringify({ sid })) } catch {} };

			// ---- draft update: committed + live partial ----
			const renderDraft = (partial) => {
				const live = (partial || "").trim();
				const base = committedRef.current.trim();
				const next = base ? (live ? base + " " + live : base) : live;
				setDraft(next);
			};

			const commitSegment = async () => {
				// send whatever pcm is buffered, then finalize this stream
				const sid = sidRef.current;
				if (!sid) return;
				stoppingRef.current = true;
				// flush remaining buffer
				const buf = pcmBufRef.current;
				if (buf.length >= SAMPLE_RATE / 100 * 5) { // >= 50ms
					const int16 = floatsToInt16(buf);
					pcmBufRef.current = [];
					try { await sendChunk(sid, int16) } catch {}
				}
				try {
					const data = await finalizeStream(sid);
					if (data.ok && data.final) {
						committedRef.current = (committedRef.current.trim() ? committedRef.current.trim() + " " : "") + data.final.trim();
					}
				} catch {}
				sidRef.current = null;
			};

			const floatsToInt16 = (floats) => {
				const out = new Int16Array(floats.length);
				for (let i = 0; i < floats.length; i++) {
					const s = Math.max(-1, Math.min(1, floats[i]));
					out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
				}
				return new Uint8Array(out.buffer);
			};

			// ---- audio pipeline ----
			const onAudioProcess = (e) => {
				const input = e.inputBuffer.getChannelData(0);
				pcmBufRef.current.push(new Float32Array(input));
			};

			const sendLoop = async () => {
				if (!runningRef.current) return;
				const sid = sidRef.current;
				if (sid && pcmBufRef.current.length) {
					let samples = 0;
					for (const b of pcmBufRef.current) samples += b.length;
					if (samples >= SAMPLE_RATE * CHUNK_MS / 1000) {
						// merge all buffered floats into one Int16 chunk
						const merged = new Float32Array(samples);
						let off = 0;
						for (const b of pcmBufRef.current) { merged.set(b, off); off += b.length }
						pcmBufRef.current = [];
						try {
							const data = await sendChunk(sid, floatsToInt16(merged));
							if (data.ok && typeof data.partial === "string") {
								renderDraft(data.partial);
								// volume from partial presence is not reliable; silence tracked separately
							}
						} catch {}
					}
				}
			};

			// RMS from the most recent buffer (called by the level timer)
			const lastRms = () => {
				const bufs = pcmBufRef.current;
				if (!bufs.length) return 0;
				const b = bufs[bufs.length - 1];
				let sum = 0;
				for (let i = 0; i < b.length; i++) { const v = b[i]; sum += v * v }
				return Math.sqrt(sum / b.length);
			};

			const levelLoop = async () => {
				if (!runningRef.current) return;
				await sendLoop();
				if (!runningRef.current) return;
				const now = Date.now();
				const rms = lastRms();
				if (rms < RMS_THRESHOLD) {
					silenceRef.current += 100;
					if (silenceRef.current >= COMMIT_SILENCE_MS && now - segStartRef.current >= MIN_SEGMENT_MS) {
						// commit this segment, start a new stream
						silenceRef.current = 0;
						segStartRef.current = now;
						const oldSid = sidRef.current;
						if (oldSid) {
							sidRef.current = null;
							try {
								const data = await finalizeStream(oldSid);
								if (data.ok && data.final) {
									committedRef.current = (committedRef.current.trim() ? committedRef.current.trim() + " " : "") + data.final.trim();
									renderDraft("");
								}
							} catch {}
							await openStream().catch(() => {});
						}
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
					const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
					audioCtxRef.current = audioCtx;
					const source = audioCtx.createMediaStreamSource(stream);
					sourceRef.current = source;
					const processor = audioCtx.createScriptProcessor(4096, 1, 1);
					processorRef.current = processor;
					processor.onaudioprocess = onAudioProcess;
					source.connect(processor);
					processor.connect(audioCtx.destination);
					committedRef.current = "";
					stoppingRef.current = false;
					runningRef.current = true;
					silenceRef.current = 0;
					segStartRef.current = Date.now();
					await openStream();
					timerRef.current = setInterval(() => { levelLoop() }, 100);
					setPhase("recording");
				} catch (e) {
					setPhase("error");
					setMsg(t("error") + ": " + String((e && e.message) || e));
				}
			};

			const stop = async () => {
				if (!runningRef.current) return;
				runningRef.current = false;
				if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
				try {
					await commitSegment();
				} catch {}
				const final = committedRef.current.trim();
				if (final) { setDraft(final); setMsg("✓ " + final.slice(0, 50) + (final.length > 50 ? "…" : "")) }
				if (processorRef.current) { try { processorRef.current.disconnect() } catch {} processorRef.current = null }
				if (sourceRef.current) { try { sourceRef.current.disconnect() } catch {} sourceRef.current = null }
				if (audioCtxRef.current) { try { audioCtxRef.current.close() } catch {} audioCtxRef.current = null }
				if (streamRef.current) { streamRef.current.getTracks().forEach((tr) => { try { tr.stop() } catch {} }); streamRef.current = null }
				pcmBufRef.current = [];
				setPhase("idle");
			};

			const onClick = () => { if (phase === "recording") stop(); else start(); };
			const recording = phase === "recording";
			return react.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
				react.createElement("button", {
					type: "button",
					title: t("mic"),
					"aria-label": t("mic"),
					onClick,
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
				msg ? react.createElement("span", { style: { fontSize: 11, opacity: 0.8, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, msg) : null
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
