import { createServer } from "node:http";
import { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import { TaskInput, type ClientMessage, type Device, type ServerMessage, type StageName } from "@webai/protocol";
import { DeviceRegistry } from "./registry.js";
import { nextStage, TaskStore } from "./tasks.js";

const options = new Command().option("-p, --port <number>", "HTTP and WebSocket port", "8787").parse().opts<{ port: string }>();
const port = Number(options.port);
const registry = new DeviceRegistry();
const tasks = new TaskStore();
const sockets = new Map<string, WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); }
function broadcast(message: ServerMessage): void { for (const socket of sockets.values()) send(socket, message); }
function volunteerDevices(): Device[] { return registry.list().filter((device) => device.role === "volunteer"); }
function updateDevices(): void { broadcast({ type: "devices", devices: volunteerDevices() }); }
function assign(taskId: string, value: number, stage: StageName, excluded: string[] = []): void {
  const device = registry.findVolunteer(stage, excluded) ?? registry.findVolunteer(stage);
  if (!device) { tasks.update(taskId, { state: "failed", error: `No volunteer is available for ${stage}` }); broadcastTask(taskId); return; }
  tasks.update(taskId, { state: "assigned" });
  const socket = sockets.get(device.id);
  if (socket) send(socket, { type: "stage.assign", taskId, stage, value });
  broadcastTask(taskId);
}
function broadcastTask(taskId: string): void { const task = tasks.get(taskId); if (task) broadcast({ type: "task.updated", task }); }
function handle(socket: WebSocket, deviceId: string, message: ClientMessage): void {
  if (message.type === "register") {
    const device: Device = { id: deviceId, name: message.name, role: message.role, capabilities: message.role === "volunteer" ? (message.capabilities ?? ["multiply", "add"]) : [], connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
    registry.add(device); send(socket, { type: "registered", deviceId }); updateDevices(); return;
  }
  if (message.type === "task.submit") { const parsed = TaskInput.safeParse(message.input); if (!parsed.success) return send(socket, { type: "error", message: "Input must be a finite number" }); const task = tasks.create(parsed.data); send(socket, { type: "task.accepted", task }); assign(task.id, task.input.input * 1, "multiply"); return; }
  if (message.type === "task.get") { const task = tasks.get(message.taskId); if (task) send(socket, { type: "task.updated", task }); else send(socket, { type: "error", message: "Task was not found" }); return; }
  if (message.type === "stage.result") {
    const device = registry.get(deviceId);
    if (!device || device.role !== "volunteer") return send(socket, { type: "error", message: "Only volunteer browser tabs may return stage results" });
    const task = tasks.get(message.taskId);
    if (!task || nextStage(task) !== message.stage) return send(socket, { type: "error", message: "Unexpected stage result" });
    const updated = tasks.addStage(task.id, { name: message.stage, value: message.value });
    const upcoming = nextStage(updated);
    if (upcoming) assign(updated.id, message.value, upcoming, [deviceId]); else tasks.update(updated.id, { state: "completed", result: message.value });
    broadcastTask(updated.id); return;
  }
  if (message.type === "stage.failed") {
    const device = registry.get(deviceId);
    if (!device || device.role !== "volunteer") return send(socket, { type: "error", message: "Only volunteer browser tabs may fail a stage" });
    tasks.update(message.taskId, { state: "failed", error: message.error }); broadcastTask(message.taskId); return;
  }
  if (message.type === "signal") { const target = sockets.get(message.to); if (target) send(target, { type: "signal", from: deviceId, data: message.data }); }
}

const adminPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebAI Administrator</title><style>body{font:16px system-ui;max-width:800px;margin:40px auto;padding:0 20px;color:#202124}h1{margin-bottom:4px}#status{color:#667085}li{margin:8px 0}pre{background:#f4f4f5;padding:16px;border-radius:8px;white-space:pre-wrap}</style></head><body><h1>WebAI Administrator</h1><button type="button" onclick="location.reload()">Reload</button><p id="status">Connecting to the central server…</p><h2>Connected volunteer browser tabs</h2><ul id="devices"><li>Waiting for volunteer browser tabs.</li></ul><h2>Task updates</h2><pre id="tasks">No tasks yet.</pre><p><a href="/volunteer">Open a volunteer browser tab</a></p><p><a href="/debug_iframe">Open the iframe debug page</a></p><script>const status=document.querySelector('#status'),devices=document.querySelector('#devices'),tasks=document.querySelector('#tasks');const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket.onopen=()=>socket.send(JSON.stringify({type:'register',role:'admin',name:'administrator'}));socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='registered')status.textContent='Connected to the central server.';if(m.type==='devices')devices.innerHTML=m.devices.filter(d=>d.role==='volunteer').map(d=>'<li>'+d.name+' (volunteer) — '+d.capabilities.join(', ')+'</li>').join('')||'<li>Waiting for volunteer browser tabs.</li>';if(m.type==='task.updated'||m.type==='task.accepted')tasks.textContent=JSON.stringify(m.task,null,2)};socket.onclose=()=>status.textContent='Disconnected from the central server.';</script></body></html>`;
const volunteerPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebAI Volunteer</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"><style>body{background:#f8f9fa}#log{min-height:360px;white-space:pre-wrap;word-break:break-word}</style></head><body><nav class="navbar navbar-dark bg-dark mb-4"><div class="container"><a class="navbar-brand" href="/">WebAI Volunteer</a></div></nav><main class="container pb-5"><div class="row justify-content-center"><div class="col-lg-9"><div class="card shadow-sm"><div class="card-body p-4"><h1 class="card-title h2">Volunteer browser tab</h1><p class="text-secondary">Connect this browser tab to make it available for WebAI tasks.</p><div class="row g-3 align-items-end"><div class="col-md-8"><label class="form-label" for="name">Volunteer name</label><input class="form-control" id="name" value="browser-volunteer"></div><div class="col-md-4"><button class="btn btn-primary w-100" id="connect" type="button">Connect</button></div></div></div></div><div class="card shadow-sm mt-4"><div class="card-header d-flex justify-content-between align-items-center"><span>Connection messages</span><span class="badge text-bg-secondary" id="status">Not connected</span></div><div class="card-body"><pre class="bg-dark text-light rounded p-3 mb-0" id="log">No messages yet.</pre></div></div></div></div></main><script>const log=v=>{const output=document.querySelector('#log');output.textContent+=(output.textContent==='No messages yet.'?'':'\\n')+JSON.stringify(v,null,2)};const status=document.querySelector('#status');const nameInput=document.querySelector('#name');nameInput.value='browser-volunteer-'+crypto.randomUUID().slice(0,8);document.querySelector('#connect').onclick=()=>{const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);status.textContent='Connecting';status.className='badge text-bg-warning';socket.onopen=()=>{status.textContent='Connected';status.className='badge text-bg-success';socket.send(JSON.stringify({type:'register',role:'volunteer',name:nameInput.value,capabilities:['multiply','add']}))};socket.onmessage=e=>{const message=JSON.parse(e.data);log(message);if(message.type==='stage.assign'){const value=message.stage==='multiply'?message.value*2:message.value+7;socket.send(JSON.stringify({type:'stage.result',taskId:message.taskId,stage:message.stage,value}))}};socket.onclose=()=>{status.textContent='Disconnected';status.className='badge text-bg-danger'}};</script></body></html>`;
const debugIframePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebAI iframe debug</title><style>html,body{height:100%;margin:0}body{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#d0d5dd;padding:8px;box-sizing:border-box}iframe{width:100%;height:100%;min-height:0;border:0;background:#fff}</style></head><body><iframe src="/" title="WebAI homepage"></iframe><iframe src="/volunteer" title="WebAI volunteer page"></iframe></body></html>`;
const httpServer = createServer((request, response) => {
  if (request.url === "/" || request.url === "/admin") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(adminPage); return; }
  if (request.url === "/volunteer") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(volunteerPage); return; }
  if (request.url === "/debug_iframe") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(debugIframePage); return; }
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") { response.end(JSON.stringify({ ok: true, devices: volunteerDevices().length })); return; }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});
const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.on("connection", (socket) => { const deviceId = crypto.randomUUID(); sockets.set(deviceId, socket); socket.on("message", (raw) => { try { handle(socket, deviceId, JSON.parse(raw.toString()) as ClientMessage); } catch { send(socket, { type: "error", message: "Invalid message" }); } }); socket.on("close", () => { sockets.delete(deviceId); registry.remove(deviceId); updateDevices(); }); });
httpServer.listen(port, () => console.log(`Central server listening on http://localhost:${port}`));
