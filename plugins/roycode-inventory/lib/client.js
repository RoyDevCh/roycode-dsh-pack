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
		function isCustomEntry(entry) {
			const id = String((entry && entry.entryId) || "");
			const mod = String((entry && entry.moduleName) || "");
			return id === "schedule" || id.startsWith("mcp-") || id.startsWith("roycode-") || mod.includes("roycode");
		}

		/** Minimal read-only list for the custom tab. */
		function CustomInventoryTab({ list }) {
			const [state, setState] = react.useState({ status: "loading", entries: [] });
			react.useEffect(() => {
				let current = true;
				Promise.resolve().then(() => list()).then((entries) => {
					if (current) setState({ status: "ready", entries: entries ?? [] });
				}, (err) => {
					if (current) setState({ status: "error", error: String((err && err.message) || err) });
				});
				return () => { current = false; };
			}, [list]);
			if (state.status === "loading") {
				return react.createElement("p", null, "Loading custom plugins…");
			}
			if (state.status === "error") {
				return react.createElement("p", { style: { color: "#e5534b" } }, "Failed to load the plugin inventory: " + (state.error || "unknown"));
			}
			return react.createElement("ul", {
				style: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }
			}, state.entries.map((entry) => react.createElement("li", {
				key: entry.entryId,
				style: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 8, padding: "10px 12px" }
			},
				react.createElement("strong", { style: { display: "block" } }, entry.moduleName),
				react.createElement("code", { style: { fontSize: 12, opacity: 0.7 } }, entry.entryId),
				react.createElement("span", { style: { marginLeft: 8, fontSize: 12 } }, entry.fiberPhase ?? "unobserved")
			)));
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
				return (result.value?.entries ?? []).filter(isCustomEntry);
			};
			const injected = () => ({ list: listCustom });
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