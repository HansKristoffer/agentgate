// The dashboard page that health.ts serves to browsers. It asks the same URL for JSON. The client code avoids
// template literals, since it lives inside one.
export const HEALTH_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Machine dashboard</title>
<style>
:root {
	color-scheme: light;
	--page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
	--grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
	--series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a;
	--good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
		--grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
		--series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; background: var(--page); color: var(--ink);
	font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 40px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 20px; font-weight: 600; margin: 0; }
h2.section { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 24px 0 8px; }
.meta { color: var(--ink-2); font-size: 13px; }
.stale { color: var(--critical); }
.services { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.pill {
	display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
	background: var(--surface); border: 1px solid var(--border); font-size: 13px;
}
.pill i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.label { color: var(--ink-2); font-size: 13px; display: flex; justify-content: space-between; gap: 8px; }
.value { font-size: 28px; font-weight: 600; margin: 6px 0 2px; }
.sub { color: var(--muted); font-size: 12px; min-height: 17px; }
.meter {
	height: 6px; border-radius: 3px; margin-top: 12px; overflow: hidden;
	background: color-mix(in srgb, var(--series-1) 18%, var(--surface));
}
.meter > div { height: 100%; border-radius: 3px; transition: width .4s; }
.badge { font-size: 12px; font-weight: 600; }
.badge.high { color: var(--warning); }
.badge.critical { color: var(--critical); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.chart h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
.legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); margin: -2px 0 6px; }
.legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.plot { position: relative; height: 160px; }
.plot svg { width: 100%; height: 100%; display: block; overflow: visible; }
.tip {
	position: absolute; pointer-events: none; background: var(--ink); color: var(--surface);
	font-size: 12px; padding: 4px 8px; border-radius: 6px; white-space: pre; display: none;
	transform: translate(-50%, calc(-100% - 10px));
}
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 5px 12px 5px 0; font-size: 13px; border-bottom: 1px solid var(--grid); }
th { color: var(--ink-2); font-weight: 600; }
th:first-child, td:first-child { text-align: left; }
tr:last-child td { border-bottom: 0; }
details { margin-top: 16px; color: var(--ink-2); }
details table { width: auto; margin-top: 8px; }
</style>
</head>
<body>
<main>
	<header>
		<h1 id="host">Machine</h1>
		<span class="meta" id="meta">Loading…</span>
	</header>
	<div class="services" id="services"></div>

	<h2 class="section">Resources</h2>
	<section class="tiles" id="resources"></section>
	<h2 class="section">Workload</h2>
	<section class="tiles" id="workload"></section>
	<h2 class="section">Pressure and I/O</h2>
	<section class="tiles" id="io"></section>

	<h2 class="section">Last hour</h2>
	<section class="charts">
		<div class="card chart"><h3>CPU used</h3><div class="plot" id="chart-cpu"></div></div>
		<div class="card chart"><h3>Load per core</h3><div class="plot" id="chart-load"></div></div>
		<div class="card chart"><h3>Memory used</h3><div class="plot" id="chart-memory"></div></div>
		<div class="card chart"><h3>Time stalled waiting (pressure)</h3><div class="plot" id="chart-pressure"></div></div>
		<div class="card chart"><h3>Agents and busy CI runners</h3><div class="plot" id="chart-workload"></div></div>
	</section>

	<h2 class="section">Top programs by CPU</h2>
	<div class="card"><table id="top"></table></div>

	<details><summary>Table: last 10 minutes, one row per minute</summary><table id="table"></table></details>
</main>
<script>
var SVG = "http://www.w3.org/2000/svg";
var lastOk = 0;

function el(name, attrs, parent) {
	var node = document.createElementNS(SVG, name);
	for (var key in attrs) node.setAttribute(key, attrs[key]);
	if (parent) parent.appendChild(node);
	return node;
}

function clock(t) {
	return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function size(gb) {
	return gb >= 1000 ? (gb / 1000).toFixed(2) + " TB" : gb.toFixed(0) + " GB";
}

// Docker prints "783.1MB"; the rest of the page puts a space before the unit.
function dockerSize(text) {
	return String(text).replace(/([0-9.])([kKMGT]?B)/, "$1 $2");
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"]/g, function (c) {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
	});
}

// Fill and badge carry severity together, so it never rests on color alone.
function severity(share, high, critical) {
	if (share >= critical) return { level: "critical", text: "Critical", color: "var(--critical)" };
	if (share >= high) return { level: "high", text: "High", color: "var(--warning)" };
	return { level: "", text: "", color: "var(--series-1)" };
}

// options: share (0..1) for a meter and badge, high/critical thresholds (default 0.7/0.9),
// meter: false to show only the badge.
function tile(label, value, sub, options) {
	var o = options || {};
	var s = o.share === undefined ? severity(0, 1, 1) : severity(o.share, o.high || 0.7, o.critical || 0.9);
	var meter = "";
	if (o.share !== undefined && o.meter !== false) {
		var width = Math.max(0, Math.min(100, o.share * 100));
		meter = '<div class="meter"><div style="width:' + width + '%;background:' + s.color + '"></div></div>';
	}
	return '<div class="card"><div class="label"><span>' + label + '</span>' +
		'<span class="badge ' + s.level + '">' + s.text + '</span></div>' +
		'<div class="value">' + value + '</div><div class="sub">' + sub + '</div>' + meter + '</div>';
}

// Only the services the daemon reports: T3 Code when agentgate is connected to it, Docker when it is installed.
function renderServices(services) {
	var names = { t3_code: "T3 Code", tailscale: "Tailscale", docker: "Docker" };
	document.getElementById("services").innerHTML = Object.keys(services).map(function (key) {
		var up = services[key];
		return '<span class="pill"><i style="background:' + (up ? "var(--good)" : "var(--critical)") + '"></i>' +
			names[key] + " " + (up ? "up" : "down") + "</span>";
	}).join("");
}

function renderTiles(data) {
	var m = data.memory;
	var d = data.disk;
	var l = data.load;
	document.getElementById("resources").innerHTML =
		tile("CPU used", data.cpu_used_percent.toFixed(0) + "%", data.cpus + " cores", { share: data.cpu_used_percent / 100 }) +
		tile("Load per core", l.per_cpu_1m.toFixed(2), "load " + l["1m"] + " · " + l["5m"] + " · " + l["15m"] + " (1, 5, 15 min)", { share: l.per_cpu_1m }) +
		tile("Memory used", m.used_percent.toFixed(0) + "%", size(m.used_gb) + " of " + size(m.total_gb), { share: m.used_percent / 100 }) +
		tile("Disk used", d.used_percent.toFixed(0) + "%", size(d.used_gb) + " of " + size(d.total_gb) + ", " + size(d.free_gb) + " free", { share: d.used_percent / 100 });

	var w = data.workload;
	var runners = w.runners;
	var containers = w.containers;
	var dockerDisk = containers.disk
		? "images " + dockerSize(containers.disk.images) + ", volumes " + dockerSize(containers.disk.volumes)
		: "disk use not measured yet";
	var oom = w.oom_kills;
	document.getElementById("workload").innerHTML =
		tile("Agents running", String(w.agents.claude + w.agents.codex), "Claude Code " + w.agents.claude + " · Codex " + w.agents.codex) +
		tile("CI runners busy", runners.busy + " of " + runners.total, runners.busy >= runners.total && runners.total > 0 ? "every runner busy, jobs queue" : (runners.total - runners.busy) + " idle",
			{ share: runners.total ? runners.busy / runners.total : 0, high: 0.75, critical: 1 }) +
		tile("Containers running", String(containers.running), dockerDisk) +
		tile("Out-of-memory kills", String(oom.since_boot), oom.last_hour + " in the last hour, since boot " + oom.since_boot,
			{ share: oom.last_hour > 0 ? 1 : 0, high: 1, critical: 1, meter: false });

	var p = data.pressure;
	var io = data.disk_io;
	var net = data.network;
	// PSI: a few percent of time stalled is noticeable, 25% is painful.
	var stalled = function (value) { return { share: value / 100, high: 0.1, critical: 0.25 }; };
	document.getElementById("io").innerHTML =
		tile("CPU pressure", p.cpu.toFixed(1) + "%", "waiting for a core, last 10 s", stalled(p.cpu)) +
		tile("Memory pressure", p.memory.toFixed(1) + "%", "waiting for memory, last 10 s", stalled(p.memory)) +
		tile("I/O pressure", p.io.toFixed(1) + "%", "waiting for disk, last 10 s", stalled(p.io)) +
		tile("Disk busy", io.busy_percent.toFixed(0) + "%", "read " + io.read_mb_s.toFixed(1) + " MB/s · write " + io.write_mb_s.toFixed(1) + " MB/s", { share: io.busy_percent / 100 }) +
		tile("Network", net.in_mbit_s.toFixed(1) + " Mbit/s in", net.out_mbit_s.toFixed(1) + " Mbit/s out (" + net.interface + ")");
}

// series: [{ key, label, color }]. One series needs no legend: the title names it.
function renderChart(id, points, series, options) {
	var box = document.getElementById(id);
	if (points.length < 2) {
		// History lives in the daemon's memory, so it starts over after a restart or when the page is turned off.
		box.innerHTML = '<p class="sub">Collecting samples, one every 5 seconds…</p>';
		return;
	}
	box.innerHTML = "";

	if (series.length > 1) {
		var legend = document.createElement("div");
		legend.className = "legend";
		legend.innerHTML = series.map(function (s) {
			return '<span><i style="background:' + s.color + '"></i>' + s.label + "</span>";
		}).join("");
		box.parentNode.insertBefore(legend, box);
		var old = box.parentNode.querySelectorAll(".legend");
		for (var i = 0; i < old.length - 1; i++) old[i].remove();
	}

	var width = box.clientWidth;
	var height = box.clientHeight;
	var left = 36;
	var top = 4;
	var plotWidth = width - left;
	var plotHeight = height - 24;
	var max = options.max(points);
	var t0 = points[0].t;
	var t1 = points[points.length - 1].t;
	var x = function (t) { return left + ((t - t0) / Math.max(1, t1 - t0)) * plotWidth; };
	var y = function (v) { return top + plotHeight - (Math.min(v, max) / max) * plotHeight; };

	var svg = el("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": options.label }, box);
	options.ticks(max).forEach(function (v) {
		el("line", { x1: left, x2: width, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }, svg);
		var text = el("text", { x: left - 6, y: y(v) + 4, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }, svg);
		text.textContent = options.format(v);
	});
	if (options.reference !== undefined && options.reference <= max) {
		el("line", { x1: left, x2: width, y1: y(options.reference), y2: y(options.reference), stroke: "var(--ink-2)", "stroke-width": 1, "stroke-dasharray": "4 4" }, svg);
		// Left edge, with a halo in the card color: the line is newest at the right.
		var ref = el("text", { x: left + 4, y: y(options.reference) - 4, fill: "var(--ink-2)", "font-size": 11, stroke: "var(--surface)", "stroke-width": 3, "paint-order": "stroke" }, svg);
		ref.textContent = options.referenceLabel;
	}
	el("line", { x1: left, x2: width, y1: top + plotHeight, y2: top + plotHeight, stroke: "var(--axis)", "stroke-width": 1 }, svg);
	[t0, t1].forEach(function (t, i) {
		var label = el("text", { x: x(t), y: height - 4, "text-anchor": i ? "end" : "start", fill: "var(--muted)", "font-size": 11 }, svg);
		label.textContent = clock(t);
	});

	series.forEach(function (s) {
		var path = points.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p[s.key]).toFixed(1); }).join("");
		el("path", { d: path, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
	});

	var cross = el("line", { y1: top, y2: top + plotHeight, stroke: "var(--ink-2)", "stroke-width": 1, visibility: "hidden" }, svg);
	var dots = series.map(function (s) {
		return el("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg);
	});
	var tip = document.createElement("div");
	tip.className = "tip";
	box.appendChild(tip);

	svg.addEventListener("pointermove", function (event) {
		var bounds = svg.getBoundingClientRect();
		var t = t0 + ((event.clientX - bounds.left - left) / plotWidth) * (t1 - t0);
		var nearest = points.reduce(function (a, b) { return Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a; });
		var cx = x(nearest.t);
		cross.setAttribute("x1", cx);
		cross.setAttribute("x2", cx);
		cross.setAttribute("visibility", "visible");
		var lines = [clock(nearest.t)];
		var highest = top + plotHeight;
		series.forEach(function (s, i) {
			var cy = y(nearest[s.key]);
			highest = Math.min(highest, cy);
			dots[i].setAttribute("cx", cx);
			dots[i].setAttribute("cy", cy);
			dots[i].setAttribute("visibility", "visible");
			lines.push((series.length > 1 ? s.label + "  " : "") + options.format(nearest[s.key]));
		});
		tip.textContent = lines.join(series.length > 1 ? "\\n" : "  ");
		tip.style.left = cx + "px";
		tip.style.top = highest + "px";
		tip.style.display = "block";
	});
	svg.addEventListener("pointerleave", function () {
		cross.setAttribute("visibility", "hidden");
		dots.forEach(function (dot) { dot.setAttribute("visibility", "hidden"); });
		tip.style.display = "none";
	});
}

var percentAxis = {
	max: function () { return 100; },
	ticks: function () { return [0, 50, 100]; },
	format: function (v) { return Math.round(v) + "%"; },
};

function ceilingOf(points, keys, floor, step) {
	var highest = floor;
	points.forEach(function (p) {
		keys.forEach(function (key) { highest = Math.max(highest, p[key]); });
	});
	return Math.ceil(highest / step) * step;
}

function renderCharts(points) {
	var one = function (key) { return [{ key: key, label: "", color: "var(--series-1)" }]; };
	renderChart("chart-cpu", points, one("cpu"), Object.assign({ label: "CPU used over the last hour" }, percentAxis));
	renderChart("chart-memory", points, one("memory"), Object.assign({ label: "Memory used over the last hour" }, percentAxis));
	renderChart("chart-load", points, one("load_per_cpu"), {
		label: "Load per core over the last hour",
		max: function (ps) { return ceilingOf(ps, ["load_per_cpu"], 1.2, 0.2); },
		ticks: function (max) { return [0, max / 2, max]; },
		format: function (v) { return v.toFixed(2); },
		reference: 1,
		referenceLabel: "1.0 = every core busy",
	});
	renderChart("chart-pressure", points, [
		{ key: "pressure_cpu", label: "CPU", color: "var(--series-1)" },
		{ key: "pressure_memory", label: "Memory", color: "var(--series-2)" },
		{ key: "pressure_io", label: "I/O", color: "var(--series-3)" },
	], {
		label: "Share of time tasks waited for CPU, memory or disk over the last hour",
		max: function (ps) { return ceilingOf(ps, ["pressure_cpu", "pressure_memory", "pressure_io"], 10, 10); },
		ticks: function (max) { return [0, max / 2, max]; },
		format: function (v) { return v.toFixed(1) + "%"; },
	});
	renderChart("chart-workload", points, [
		{ key: "agents", label: "Agents", color: "var(--series-1)" },
		{ key: "runners_busy", label: "Busy CI runners", color: "var(--series-2)" },
	], {
		label: "Agents running and busy CI runners over the last hour",
		max: function (ps) { return ceilingOf(ps, ["agents", "runners_busy"], 4, 2); },
		ticks: function (max) { return [0, max / 2, max]; },
		format: function (v) { return String(Math.round(v)); },
	});
}

function renderTop(top) {
	var rows = top.map(function (p) {
		return "<tr><td>" + escapeHtml(p.program) + "</td><td>" + p.processes + "</td><td>" +
			p.cpu_cores.toFixed(2) + "</td><td>" + p.memory_gb.toFixed(2) + " GB</td></tr>";
	});
	document.getElementById("top").innerHTML =
		"<tr><th>Program</th><th>Processes</th><th>CPU (cores)</th><th>Memory</th></tr>" + rows.join("");
}

function renderTable(points) {
	var perMinute = points.filter(function (p, i) { return (points.length - 1 - i) % 12 === 0; }).slice(-10).reverse();
	var rows = perMinute.map(function (p) {
		return "<tr><td>" + clock(p.t) + "</td><td>" + p.cpu.toFixed(0) + "%</td><td>" + p.load_per_cpu.toFixed(2) +
			"</td><td>" + p.memory.toFixed(0) + "%</td><td>" + p.agents + "</td><td>" + p.runners_busy +
			"</td><td>" + p.pressure_cpu.toFixed(1) + " · " + p.pressure_memory.toFixed(1) + " · " + p.pressure_io.toFixed(1) + "%</td></tr>";
	});
	document.getElementById("table").innerHTML =
		"<tr><th>Time</th><th>CPU</th><th>Load per core</th><th>Memory</th><th>Agents</th><th>Busy runners</th>" +
		"<th>Pressure CPU · memory · I/O</th></tr>" + rows.join("");
}

function render(data) {
	document.getElementById("host").textContent = data.host;
	renderServices(data.services);
	renderTiles(data);
	renderCharts(data.history);
	renderTop(data.top_processes);
	renderTable(data.history);
}

function refresh() {
	fetch(location.pathname + "?history=1", { headers: { accept: "application/json" }, cache: "no-store" })
		.then(function (response) {
			// 503 while the first sample is taken; 501 on a machine that is not Linux.
			if (!response.ok) throw new Error("no sample yet");
			return response.json();
		})
		.then(function (data) {
			lastOk = Date.now();
			render(data);
		})
		.catch(function () {});
}

setInterval(function () {
	var meta = document.getElementById("meta");
	if (!lastOk) return;
	var seconds = Math.round((Date.now() - lastOk) / 1000);
	var stale = seconds > 20;
	meta.className = stale ? "meta stale" : "meta";
	meta.textContent = stale ? "No answer for " + seconds + "s" : "Updated " + seconds + "s ago, every 5s";
}, 1000);

refresh();
setInterval(refresh, 5000);
window.addEventListener("resize", refresh);
</script>
</body>
</html>`;
