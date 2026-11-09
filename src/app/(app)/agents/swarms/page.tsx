"use client";

import { useEffect, useState } from "react";
import { Network, Plus, Trash2, Play, Bot, ArrowDown, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/info-tooltip";

type Agent = {
  id: string;
  name: string;
  emoji: string;
  role: string;
};

type Node = {
  agentId: string;
  order: number;
  customPrompt: string;
  agentName?: string;
  agentEmoji?: string;
  agentRole?: string;
};

type Swarm = {
  id: string;
  name: string;
  description: string;
  nodes: string; // JSON string
};

export default function SwarmsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [swarms, setSwarms] = useState<Swarm[]>([]);
  
  const [swarmName, setSwarmName] = useState("New Swarm Pipeline");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [currentSwarmId, setCurrentSwarmId] = useState<string | null>(null);
  
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [swarmInput, setSwarmInput] = useState("");

  useEffect(() => {
    fetchAgents();
    fetchSwarms();
  }, []);

  async function fetchAgents() {
    try {
      const res = await fetch("/api/agents").then(r => r.json());
      if (res.agents) setAgents(res.agents);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchSwarms() {
    try {
      const res = await fetch("/api/agents/swarms").then(r => r.json());
      if (res.swarms) setSwarms(res.swarms);
    } catch (err) {
      console.error(err);
    }
  }

  const handleDragStart = (e: React.DragEvent, agent: Agent) => {
    e.dataTransfer.setData("agent", JSON.stringify(agent));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const agentData = e.dataTransfer.getData("agent");
    if (!agentData) return;
    
    try {
      const agent: Agent = JSON.parse(agentData);
      setNodes(prev => [
        ...prev, 
        { 
          agentId: agent.id, 
          order: prev.length, 
          customPrompt: "",
          agentName: agent.name,
          agentEmoji: agent.emoji,
          agentRole: agent.role
        }
      ]);
    } catch {}
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const removeNode = (index: number) => {
    setNodes(prev => prev.filter((_, i) => i !== index).map((n, i) => ({ ...n, order: i })));
  };

  const updateNodePrompt = (index: number, prompt: string) => {
    setNodes(prev => {
      const newNodes = [...prev];
      newNodes[index].customPrompt = prompt;
      return newNodes;
    });
  };

  function loadSwarm(swarm: Swarm) {
    try {
      const parsedNodes = JSON.parse(swarm.nodes);
      setNodes(parsedNodes);
      setSwarmName(swarm.name);
      setCurrentSwarmId(swarm.id);
      setRunLogs([`[System] Loaded swarm "${swarm.name}"`]);
    } catch (err) {
      console.error("Load Swarm Error:", err);
      alert("Failed to load swarm.");
    }
  }

  async function deleteSwarm(id: string) {
    if (!confirm("Are you sure you want to delete this swarm?")) return;
    try {
      const res = await fetch("/api/agents/swarms", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        fetchSwarms();
        if (currentSwarmId === id) {
          setNodes([]);
          setSwarmName("New Swarm Pipeline");
          setCurrentSwarmId(null);
        }
      } else {
        alert("Failed to delete swarm.");
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function saveSwarm() {
    if (nodes.length === 0) return alert("Add at least one agent to the swarm.");
    setSaving(true);
    try {
      const res = await fetch("/api/agents/swarms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: currentSwarmId, name: swarmName, description: "", nodes }),
      });
      const data = await res.json();
      if (res.ok && data.swarm) {
        setCurrentSwarmId(data.swarm.id);
        fetchSwarms();
        alert("Swarm saved successfully!");
      } else {
        alert("Failed to save swarm.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function runSwarm() {
    if (nodes.length === 0) return;
    
    setRunning(true);
    setRunLogs(["[System] Saving and initializing swarm execution..."]);
    
    let swarmId = currentSwarmId;
    try {
      const saveRes = await fetch("/api/agents/swarms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: currentSwarmId, name: swarmName, description: "", nodes }),
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok || !saveData.swarm) {
        throw new Error("Failed to save/prepare swarm for running.");
      }
      swarmId = saveData.swarm.id;
      setCurrentSwarmId(swarmId);
      fetchSwarms();
    } catch (err) {
      setRunning(false);
      return alert((err as Error).message || "Failed to prepare swarm.");
    }

    try {
      const res = await fetch(`/api/agents/swarms/${swarmId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: swarmInput }),
      });

      if (!res.ok) throw new Error("Run failed");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              setRunning(false);
              break;
            }
            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'step_start') {
                setRunLogs(prev => [...prev, `[Step ${data.order + 1}] Starting ${data.agentName}...`]);
              } else if (data.type === 'step_done') {
                setRunLogs(prev => [...prev, `[Step ${data.order ?? 'Done'}] ${data.agentName} finished in ${(data.duration_ms/1000).toFixed(1)}s. Output:\n${data.output}`]);
              } else if (data.type === 'complete') {
                setRunLogs(prev => [...prev, `\n[System] Swarm completed successfully!`]);
              } else if (data.type === 'error') {
                setRunLogs(prev => [...prev, `\n[Error] ${data.error}`]);
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      setRunLogs(prev => [...prev, "[Error] Failed to execute swarm."]);
      setRunning(false);
    }
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background/50">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/50 px-6 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-500">
            <Network className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold flex items-center gap-2">
              Agent Swarm Builder
              <InfoTooltip text="Chain multiple AI agents into a sequence. When the swarm runs, the output of one agent is passed as context to the next agent in line!" />
            </h1>
            <p className="text-[10px] text-muted-foreground">Chain multiple AI agents into a sequential pipeline</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={saveSwarm} disabled={saving || running}>
            <Save className="mr-2 h-4 w-4" /> {saving ? "Saving..." : "Save Swarm"}
          </Button>
          <Button size="sm" onClick={runSwarm} disabled={running || nodes.length === 0}>
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {running ? "Running..." : "Run Swarm"}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Palette */}
        <div className="w-72 shrink-0 border-r border-border bg-card flex flex-col h-full">
          <div className="flex-1 flex flex-col min-h-0 border-b border-border">
            <div className="p-4 border-b border-border">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Available Agents</h2>
              <p className="text-xs text-muted-foreground">Drag agents to the canvas to build your pipeline.</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
              {agents.map(agent => (
                <div
                  key={agent.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, agent)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background p-3 cursor-grab hover:border-primary/50 transition-colors shadow-sm"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-lg shrink-0">
                    {agent.emoji || "🤖"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate text-foreground">{agent.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{agent.role}</div>
                  </div>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="text-center py-8 text-xs text-muted-foreground">
                  No active agents found. Deploy some agents first.
                </div>
              )}
            </div>
          </div>
          <div className="h-64 flex flex-col min-h-0">
            <div className="p-4 border-b border-border bg-muted/20">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Saved Swarms</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin bg-muted/5">
              {swarms.map(swarm => (
                <div key={swarm.id} className="flex items-center justify-between p-2 rounded border border-border bg-background text-xs hover:border-primary/40 transition-colors">
                  <span role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); loadSwarm(swarm); } }} className="truncate font-medium flex-1 cursor-pointer hover:text-primary transition-colors" onClick={() => loadSwarm(swarm)}>
                    {swarm.name}
                  </span>
                  <button aria-label="Delete" onClick={() => deleteSwarm(swarm.id)} className="p-1 text-muted-foreground hover:text-red-500 rounded ml-2">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {swarms.length === 0 && (
                <div className="text-center py-4 text-[10px] text-muted-foreground">No saved swarms.</div>
              )}
            </div>
          </div>
        </div>

        {/* Center Canvas */}
        <div 
          className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950/50 p-8 scrollbar-thin relative flex flex-col items-center"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input aria-label="Swarm name"
            value={swarmName}
            onChange={(e) => setSwarmName(e.target.value)}
            className="text-2xl font-bold bg-transparent border-none text-center focus:outline-none focus:ring-0 mb-8 w-full max-w-md placeholder:text-muted-foreground/50"
            placeholder="Swarm Name"
          />

          <div className="w-full max-w-xl flex flex-col items-center space-y-0">
            {nodes.map((node, i) => (
              <div key={`${node.agentId}-${i}`} className="w-full flex flex-col items-center">
                
                {/* Connecting Arrow */}
                {i > 0 && (
                  <div className="flex flex-col items-center justify-center h-12 w-full">
                    <div className="w-px h-full bg-border"></div>
                    <ArrowDown className="h-4 w-4 text-muted-foreground -mt-2 bg-zinc-50 dark:bg-zinc-950" />
                  </div>
                )}

                {/* Node Card */}
                <div className="w-full bg-card border border-border rounded-xl shadow-sm p-4 relative group hover:border-primary/50 transition-colors">
                  <div className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold shadow-sm">
                    {i + 1}
                  </div>
                  <button aria-label="Delete" 
                    onClick={() => removeNode(i)}
                    className="absolute right-3 top-3 p-1.5 rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>

                  <div className="flex items-center gap-3 mb-4 pr-8">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-xl shrink-0">
                      {node.agentEmoji || "🤖"}
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">{node.agentName}</h3>
                      <p className="text-xs text-muted-foreground">{node.agentRole}</p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold uppercase text-muted-foreground">Custom Instructions (Optional)</label>
                    <textarea aria-label="E.g. Format output as JSON, focus on X..." 
                      value={node.customPrompt}
                      onChange={(e) => updateNodePrompt(i, e.target.value)}
                      placeholder="E.g. Format output as JSON, focus on X..."
                      className="w-full text-sm bg-background border border-input rounded-md px-3 py-2 h-16 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

              </div>
            ))}

            {nodes.length === 0 && (
              <div className="h-64 w-full border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center text-muted-foreground bg-card/30">
                <Plus className="h-8 w-8 mb-2 opacity-50" />
                <p className="font-medium text-sm">Drag & drop agents here</p>
                <p className="text-xs opacity-70">Build your sequential swarm pipeline</p>
              </div>
            )}
            
            {nodes.length > 0 && (
              <div className="mt-8 w-full">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">Initial Input / Context</label>
                <textarea aria-label="The initial prompt or context to feed into the first agent..." 
                  value={swarmInput}
                  onChange={e => setSwarmInput(e.target.value)}
                  placeholder="The initial prompt or context to feed into the first agent..."
                  className="w-full rounded-lg border border-input bg-card p-4 text-sm shadow-sm min-h-[100px] focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar - Execution Logs */}
        <div className="w-80 shrink-0 border-l border-border bg-card flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Execution Logs</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 bg-zinc-950 font-mono text-[11px] leading-relaxed text-zinc-300 scrollbar-thin whitespace-pre-wrap">
            {runLogs.length === 0 ? (
              <span className="text-zinc-600 italic">No logs yet. Click &apos;Run Swarm&apos; to see output.</span>
            ) : (
              runLogs.map((log, i) => (
                <div key={i} className="mb-2 pb-2 border-b border-zinc-800 last:border-0">{log}</div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
