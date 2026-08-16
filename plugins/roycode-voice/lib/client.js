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

		const zh = {
			mic: "语音输入",
			recording: "录音中，点按停止",
			transcribing: "转写中…",
			error: "失败"
		};
		const en = {
			mic: "Voice input",
			recording: "Recording - tap to stop",
			transcribing: "Transcribing…",
			error: "Failed"
		};

		/** Mic button in the composer tool row: record -> transcribe -> send. */
		function VoiceButton({ send, t }) {
			const [phase, setPhase] = react.useState("idle");
			const [msg, setMsg] = react.useState("");
			const recorderRef = react.useRef(null);
			const chunksRef = react.useRef([]);
			const timerRef = react.useRef(null);

			const transcribe = async (blob) => {
				setPhase("transcribing");
				try {
					const res = await fetch(TRIGGERS_BASE + "/voice/transcribe", {
						method: "POST",
						headers: { "content-type": blob.type || "audio/webm" },
						body: blob
					});
					const data = await res.json();
					if (!data.ok || !data.transcript) {
						setPhase("error");
						setMsg(t("error") + ": " + (data.error || "no speech detected"));
						return;
					}
					await send(data.transcript);
					setPhase("idle");
					setMsg("✓ " + data.transcript.slice(0, 60) + (data.transcript.length > 60 ? "…" : ""));
				} catch (e) {
					setPhase("error");
					setMsg(t("error") + ": " + String((e && e.message) || e));
				}
			};

			const start = async () => {
				setMsg("");
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					const rec = new MediaRecorder(stream);
					chunksRef.current = [];
					rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
					rec.onstop = () => {
						stream.getTracks().forEach((tr) => { try { tr.stop() } catch {} });
						const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
						transcribe(blob);
					};
					rec.onerror = () => { setPhase("error"); setMsg(t("error")); };
					recorderRef.current = rec;
					rec.start();
					setPhase("recording");
					timerRef.current = setTimeout(() => { try { rec.stop() } catch {} }, MAX_RECORD_MS);
				} catch (e) {
					setPhase("error");
					setMsg(t("error") + ": " + String((e && e.message) || e));
				}
			};

			const stop = () => {
				if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
				try { if (recorderRef.current) recorderRef.current.stop() } catch {}
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
						return {
							send: (text) => actx.conversation.send(text)
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
