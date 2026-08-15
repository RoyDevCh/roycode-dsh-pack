window.__ModuleLoader__.load({
	id: "roycode-inventory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region roycode-inventory
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.roycodeInventory";
		/** Services required by the tab registration and Remote face. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.pluginInventory"
		];
		/** Simplified Chinese dictionary. */
		const zh = { tab: "自定义" };
		/** English dictionary checked against the Chinese key set. */
		const en = { tab: "Custom" };

		/**
		 * Keep only roycode-dsh-pack entries: mcp-*, roycode-*, schedule.
		 * @param entries - full plugin inventory.
		 * @returns the custom subset.
		 */
		/** Loader entry ids from patch inserts carry an "include:" prefix. */
		function bareEntryId(entry) {
			return String((entry && entry.entryId) || "").replace(/^include:/, "");
		}

		function isCustomEntry(entry) {
			const bare = bareEntryId(entry);
			const mod = String((entry && entry.moduleName) || "");
			return bare === "schedule" || bare.startsWith("mcp-") || bare.startsWith("roycode-") || mod.includes("roycode");
		}

		/** roycode-triggers host endpoint base (must match its config.port). */
		const TRIGGERS_BASE = "http://127.0.0.1:8787";

		/** Custom tab: list + per-entry enable/disable toggle + debug details. */
		function CustomInventoryTab({ list, setRawIds }) {
			const [state, setState] = react.useState({ status: "loading", entries: [], rawIds: [] });
			const [disabledSet, setDisabledSet] = react.useState([]);
			const [toggleMsg, setToggleMsg] = react.useState("");
			react.useEffect(() => {
				let current = true;
				Promise.resolve().then(() => list()).then((entries) => {
					if (current) setState((s) => ({ ...s, status: "ready", entries: entries ?? [] }));
				}, (err) => {
					if (current) setState((s) => ({ ...s, status: "error", error: String((err && err.message) || err) }));
				});
				return () => { current = false; };
			}, [list]);
			react.useEffect(() => {
				let current = true;
				fetch(TRIGGERS_BASE + "/plugins/disabled").then((res) => res.json()).then((data) => {
					if (current && Array.isArray(data.disabled)) setDisabledSet(data.disabled);
				}).catch(() => {});
				return () => { current = false; };
			}, []);
			const toggle = (id) => {
				setToggleMsg("");
				fetch(TRIGGERS_BASE + "/plugins/toggle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id })
				}).then((res) => res.json()).then((data) => {
					if (data.ok) {
						setDisabledSet((prev) => data.disabled ? [...prev, id] : prev.filter((x) => x !== id));
						setToggleMsg(id + (data.disabled ? " disabled" : " enabled") + " - restart dsh web to apply");
					} else {
						setToggleMsg("toggle failed: " + (data.error || "unknown"));
					}
				}).catch((err) => setToggleMsg("toggle failed: " + String((err && err.message) || err)));
			};
			if (state.status === "loading") {
				return react.createElement("p", null, "Loading custom plugins…");
			}
			if (state.status === "error") {
				return react.createElement("p", { style: { color: "#e5534b" } }, "Failed to load the plugin inventory: " + (state.error || "unknown"));
			}
			return react.createElement("div", null,
				toggleMsg ? react.createElement("p", { style: { color: "#d29922", fontSize: 12 } }, toggleMsg) : null,
				react.createElement("ul", {
					style: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }
				}, state.entries.map((entry) => {
					const bare = bareEntryId(entry);
					const isOff = disabledSet.includes(bare);
					return react.createElement("li", {
						key: entry.entryId,
						style: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }
					},
						react.createElement("div", { style: { flex: 1, minWidth: 0 } },
							react.createElement("strong", { style: { display: "block" } }, entry.moduleName),
							react.createElement("code", { style: { fontSize: 12, opacity: 0.7 } }, bare),
							react.createElement("span", { style: { marginLeft: 8, fontSize: 12 } }, entry.fiberPhase ?? "unobserved")
						),
						react.createElement("button", {
							type: "button",
							onClick: () => toggle(bare),
							style: { flex: "none", fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #aaa)", background: isOff ? "#e5534b" : "transparent", color: isOff ? "#fff" : "inherit", cursor: "pointer" }
						}, isOff ? "停用中·启用" : "停用")
					);
				})),
				react.createElement("details", { style: { marginTop: 12, fontSize: 11, opacity: 0.75 } },
					react.createElement("summary", null, "debug: custom=" + state.entries.length + " raw=" + state.rawIds.length),
					react.createElement("code", null, state.rawIds.join(", ") || "(raw ids not captured)")
				)
			);
		}

		/** Register the "custom" tab next to the built-in "all" tab. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "roycode-inventory: dictionaries");
			const t = ctx.locale.bind(NS);
			const listCustom = async () => {
				const gateway = ctx.remote && ctx.remote.pluginInventory;
				if (!gateway || typeof gateway.list !== "function") {
					throw new Error("remote service pluginInventory.list is not available (gateway=" + Boolean(ctx.remote) + ")");
				}
				const result = await gateway.list();
				if (!result.ok) throw new Error("pluginInventory.list failed: " + result.error.code + ": " + result.error.message);
				// result.value is a PluginInventorySnapshot object, not an array
				const all = result.value?.entries ?? [];
				setRawIds(all.map((e) => String((e && e.entryId) || "?")));
				return all.filter(isCustomEntry);
			};
			let setRawIds = () => {};
			const injected = () => ({ list: listCustom, setRawIds });
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "custom",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, CustomInventoryTab));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});