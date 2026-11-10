import { itemPhases } from "@agentgate/protocol";

// The board page that `/factory` serves to browsers. It asks the same URL for the board's JSON every 10 seconds and
// draws it with the DOM, so text from issues and threads is never parsed as HTML. No external assets: the tailnet
// listener may be the only thing the browser can reach. The client code avoids template literals, since it lives
// inside one.
export const FACTORY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory board</title>
<style>
:root {
	color-scheme: light;
	--page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
	--border: rgba(11,11,11,0.10); --accent: #2a78d6;
	--good: #0ca30c; --warning: #b7820a; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
		--border: rgba(255,255,255,0.10); --accent: #3987e5;
		--good: #3bbf3b; --warning: #e0a72a; --critical: #e25c5c;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; background: var(--page); color: var(--ink);
	font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1280px; margin: 0 auto; padding: 28px 16px 40px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 20px; font-weight: 600; margin: 0; }
h2 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 24px 0 8px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { color: var(--ink-2); font-size: 13px; }
.muted { color: var(--muted); }
.bad { color: var(--critical); }
.warn { color: var(--warning); }
.good { color: var(--good); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.pill {
	display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
	background: var(--surface); border: 1px solid var(--border); font-size: 13px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.good { background: var(--good); } .dot.warn { background: var(--warning); } .dot.bad { background: var(--critical); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.tile, .card, .column, .machine {
	background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px;
}
.tile .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .label { color: var(--ink-2); font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.card { border-left: 3px solid var(--warning); }
.card .reason { font-size: 12px; font-weight: 600; color: var(--warning); }
.card .title { font-weight: 600; margin: 2px 0 4px; }
.card p { margin: 4px 0; color: var(--ink-2); }
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; align-items: start; }
.pipeline { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; color: var(--ink-2); }
.column { padding: 8px; min-height: 80px; }
.column h3 { font-size: 12px; font-weight: 600; color: var(--ink-2); margin: 2px 4px 8px; }
.item { padding: 8px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; background: var(--page); }
.item .key { font-size: 12px; color: var(--muted); }
.item .sub { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.machines { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 8px; }
.machine h3 { font-size: 14px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
.thread { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-top: 1px solid var(--border); }
.thread .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread .status { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
td, th { text-align: left; padding: 6px 10px; border-top: 1px solid var(--border); font-size: 13px; }
th { color: var(--ink-2); font-weight: 600; border-top: none; }
.events div { padding: 3px 0; font-size: 13px; }
.empty { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
<header>
	<h1>Factory</h1>
	<span class="meta" id="updated">Loading…</span>
</header>
<div class="meta" id="pointer"></div>
<div class="row" id="status"></div>
<div id="needs"></div>
<h2>Capacity</h2>
<div class="tiles" id="capacity"></div>
<section id="metrics-section">
<h2>Last 7 days</h2>
<div class="tiles" id="metrics"></div>
</section>
<h2>Items</h2>
<div class="board" id="items"></div>
<h2>Machines</h2>
<div class="machines" id="machines"></div>
<h2>Sources</h2>
<div id="sources"></div>
<h2>Recent</h2>
<div class="events" id="events"></div>
</main>
<script>
var PHASES = ${JSON.stringify(itemPhases)};
var OPEN = ["held", "triage", "spec", "implement", "pr", "review", "ready"];

function el(tag, cls, text) {
	var node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined && text !== null) node.textContent = String(text);
	return node;
}
function link(text, href) {
	if (!href || !/^https?:/.test(href)) return el("span", "", text);
	var a = el("a", "", text);
	a.href = href; a.target = "_blank"; a.rel = "noreferrer";
	return a;
}
function fill(id, nodes) {
	var parent = document.getElementById(id);
	parent.replaceChildren.apply(parent, nodes);
}
function ago(at) {
	var minutes = Math.round((Date.now() - at) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return minutes + "m ago";
	var hours = Math.round(minutes / 60);
	return hours < 48 ? hours + "h ago" : Math.round(hours / 24) + "d ago";
}
function hookText(w) {
	if (!w.configured) return "not configured";
	var parts = ["configured"];
	if (w.relayServes === false) parts.push("the relay does not serve webhook URLs");
	else if (w.connected === false) parts.push("not connected to the relay");
	parts.push(w.lastDelivery ? "last delivery " + ago(w.lastDelivery.at) + " (" + w.lastDelivery.status + ")" : "no delivery yet");
	return parts.join(", ");
}
function pill(text, tone) {
	var p = el("span", "pill");
	p.append(el("span", "dot " + (tone || "")), el("span", "", text));
	return p;
}
function percent(rate) { return Math.round(rate * 100) + "%"; }
function tokens(n) {
	return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));
}
function tile(value, label) {
	var t = el("div", "tile");
	t.append(el("div", "value", value), el("div", "label", label));
	return t;
}

function render(b) {
	var f = b.factory;
	var pointer = f
		? f.label + " on " + f.node + (f.online ? "" : " (offline)")
		: "The factory is off. Turn it on with agentgate factory use <owner/repo>.";
	if (f && f.moving) {
		var open = f.moving.open;
		pointer += ". Moving to " + f.moving.to + " once " + (open === undefined ? "its open items finish" : open === 0 ? "its last comments are posted" : open === 1 ? "1 item finishes" : open + " items finish");
	}
	var frozen = b.frozen || [];
	if (f && frozen.length) {
		pointer += ". Frozen on " + b.node + " until the factory moves back or you drop them: " + frozen.map(function (i) { return i.key; }).join(", ");
	}
	document.getElementById("pointer").textContent = pointer;

	var status = [
		pill("T3 stream " + b.t3.stream, b.t3.stream === "live" ? "good" : b.t3.stream === "polling" ? "warn" : "bad"),
		pill("T3 MCP " + b.t3.mcp, b.t3.mcp === "signed-in" ? "good" : b.t3.mcp === "off" ? "" : b.t3.mcp === "failed" ? "bad" : "warn"),
	];
	if (b.config) status.push(pill("config " + b.config.name + " " + b.config.commit.slice(0, 7), b.config.error ? "bad" : "good"));
	if (b.t3.error) status.push(el("span", "meta bad", b.t3.error));
	if (b.config && b.config.error) status.push(el("span", "meta bad", b.config.error));
	fill("status", status);

	var cards = [];
	b.items.forEach(function (i) {
		if (!i.needsYou && i.phase !== "ready") return;
		var c = el("div", "card");
		if (!i.needsYou) {
			c.append(el("div", "reason", "ready for your review"), el("div", "title", i.key + " " + i.title));
			if (i.pr) c.append(link("Open", i.pr.url));
			cards.push(c);
			return;
		}
		c.append(el("div", "reason", i.needsYou.title), el("div", "title", i.key + " " + i.title));
		c.append(el("p", "", i.needsYou.question));
		if (i.needsYou.recommendation) c.append(el("p", "", "Recommended: " + i.needsYou.recommendation));
		if (i.needsYou.options) c.append(el("p", "", "Options: " + i.needsYou.options.join("; ")));
		var go = i.needsYou.link || (i.run && i.run.threadLink) || i.url;
		if (go) c.append(link("Open", go));
		cards.push(c);
	});
	b.machines.forEach(function (m) {
		m.threads.forEach(function (t) {
			if (!t.needsYou || t.item) return;
			var c = el("div", "card");
			c.append(el("div", "reason", "thread on " + m.node), el("div", "title", t.title));
			if (t.project) c.append(el("p", "", t.project));
			if (t.link) c.append(link("Open", t.link));
			cards.push(c);
		});
	});
	var needs = cards.length ? [el("h2", "", "Needs you"), (function () { var g = el("div", "cards"); g.append.apply(g, cards); return g; })()] : [];
	fill("needs", needs);

	var c = b.capacity;
	fill("capacity", [
		tile(c.working + " / " + c.threads, "threads working"),
		tile(c.waitingForYou + " / " + c.waitingForYouLimit, "waiting for you"),
		tile(c.paused ? "paused" : c.intake, "intake"),
		tile(c.quota === "ok" ? "ok" : "waiting", "quota" + (c.quota !== "ok" && c.quota.waitingUntil ? " until " + new Date(c.quota.waitingUntil).toLocaleTimeString() : "")),
		tile(c.mainRed.length ? c.mainRed.join(", ") : "none", "main is red"),
	]);

	var m = b.metrics;
	document.getElementById("metrics-section").hidden = !f;
	var none = "–";
	fill("metrics", [
		tile(m.merged, "merged"),
		tile(percent(m.mergeRate), "merge rate"),
		tile(m.reverts14d, "reverted within 14 days"),
		tile(m.medianHoursToMerge === undefined ? none : m.medianHoursToMerge.toFixed(1) + "h", "median time to merge"),
		tile(m.humanTouchesPerItem === undefined ? none : m.humanTouchesPerItem.toFixed(1), "human touches per item"),
		tile(m.tokensPerMergedPr === undefined ? none : tokens(m.tokensPerMergedPr), "tokens per merged PR"),
	]);

	// Every stage in one line, and a column only for those that hold items: all of them at a card's width do not fit.
	var phases = PHASES.filter(function (phase) {
		return OPEN.indexOf(phase) >= 0 || b.items.some(function (i) { return i.phase === phase; });
	});
	var pipeline = el("div", "pipeline");
	phases.forEach(function (phase) {
		pipeline.append(el("span", "", phase + " " + b.items.filter(function (i) { return i.phase === phase; }).length));
	});
	var columns = [pipeline].concat(phases.filter(function (phase) {
		return b.items.some(function (i) { return i.phase === phase; });
	}).map(function (phase) {
		var col = el("div", "column");
		var here = b.items.filter(function (i) { return i.phase === phase; });
		col.append(el("h3", "", phase + " " + here.length));
		here.forEach(function (i) {
			var card = el("div", "item");
			card.append(el("div", "key", i.key + " · " + i.repo), link(i.title, i.url));
			var sub = [];
			if (i.waiting) sub.push(i.waiting.text);
			else if (i.run) sub.push(i.run.kind + " " + i.run.state);
			if (i.pr) sub.push("PR" + (i.pr.openFindings ? ", " + i.pr.openFindings + " findings" : ""));
			if (i.tokensUnknown) sub.push("tokens unknown");
			sub.push("since " + ago(i.inPhaseSince));
			card.append(el("div", "sub", sub.join(" · ")));
			col.append(card);
		});
		return col;
	}));
	fill("items", columns);

	fill("machines", b.machines.map(function (m) {
		var box = el("div", "machine");
		var h = el("h3");
		h.append(el("span", "dot " + (m.online ? "good" : "bad")), el("span", "", m.node + (m.node === b.node ? " (this machine)" : "")));
		box.append(h);
		if (!m.online) box.append(el("div", "empty", "offline"));
		else if (!m.threads.length) box.append(el("div", "empty", "no factory threads"));
		m.threads.forEach(function (t) {
			var row = el("div", "thread");
			var name = el("span", "name");
			name.append(link(t.title, t.link));
			if (t.project) name.append(el("span", "muted", " " + t.project));
			row.append(name, el("span", "status " + (t.needsYou ? "warn" : ""), t.needsYou ? "needs you" : t.status));
			box.append(row);
		});
		return box;
	}));

	if (!b.sources.length) fill("sources", [el("div", "empty", "No sources yet.")]);
	else {
		var table = el("table");
		var head = el("tr");
		["Source", "Type", "Repository", "Last poll or run", "Schedule", "Webhook", "Problem"].forEach(function (t) { head.append(el("th", "", t)); });
		table.append(head);
		b.sources.forEach(function (s) {
			var tr = el("tr");
			tr.append(
				el("td", "", s.id), el("td", "", s.type), el("td", "", s.repo),
				el("td", "", s.scout
					? (s.scout.lastRun ? ago(s.scout.lastRun.at) + ", filed " + s.scout.lastRun.filed : "never")
					: s.lastPollAt ? ago(s.lastPollAt) : "never"),
				el("td", "", s.scout
					? s.scout.schedule + (s.scout.enabled ? "" : ", disabled")
						+ (s.scout.nextAt ? ", next " + new Date(s.scout.nextAt).toLocaleString() : "")
					: ""),
				el("td", "", s.webhook ? hookText(s.webhook) : "none"),
				el("td", "bad", s.error || ""));
			table.append(tr);
		});
		fill("sources", [table]);
	}

	fill("events", b.events.length ? b.events.slice(0, 20).map(function (e) {
		var row = el("div");
		row.append(el("span", "muted", ago(e.at) + "  "), el("span", "", e.text));
		return row;
	}) : [el("div", "empty", "Nothing yet.")]);
}

var lastOk = 0;
async function refresh() {
	try {
		var res = await fetch(location.pathname, { headers: { accept: "application/json" }, cache: "no-store" });
		if (!res.ok) throw new Error("HTTP " + res.status);
		render(await res.json());
		lastOk = Date.now();
		var u = document.getElementById("updated");
		u.textContent = "Updated " + new Date(lastOk).toLocaleTimeString();
		u.className = "meta";
	} catch (e) {
		var u = document.getElementById("updated");
		u.textContent = lastOk ? "Stale since " + new Date(lastOk).toLocaleTimeString() : "Could not load the board";
		u.className = "meta bad";
	}
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`;
