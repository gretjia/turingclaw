import { useEffect, useState, useRef } from 'react';
import { Terminal, FileText, Folder, Play, Square, Cpu, HardDrive } from 'lucide-react';
import Markdown from 'react-markdown';

export default function App() {
  const [tape, setTape] = useState<string>('# TAPE.md\n\n[SYSTEM]: Connecting to TuringClaw Engine...');
  const [agentState, setAgentState] = useState<'idle' | 'running'>('idle');
  const [qState, setQState] = useState<string>('q_0: SYSTEM_BOOTING');
  const [dState, setDState] = useState<string>('MAIN_TAPE.md');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const tapeEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Connect WebSocket
    const getWsUrl = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host || (process.env.APP_URL ? new URL(process.env.APP_URL).host : '');
      if (!host) {
        console.error('Could not determine host for WebSocket');
        return null;
      }
      return `${protocol}//${host}`;
    };

    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    console.log('Connecting to WebSocket:', wsUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('WebSocket creation failed:', e);
      return;
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'tape_update') {
          setTape(data.content);
          setTimeout(() => tapeEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        } else if (data.type === 'status') {
          setAgentState(data.status);
          if (data.status === 'idle') {
            fetchFiles(); // Refresh files when agent finishes
          }
        } else if (data.type === 'state_update') {
          setQState(data.q);
          setDState(data.d);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message', e);
      }
    };

    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
    };

    fetchFiles();

    return () => ws.close();
  }, []);

  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/workspace');
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch (e: any) {
      console.error('Failed to fetch files:', e.message);
    }
  };

  const loadFile = async (filename: string) => {
    try {
      const res = await fetch(`/api/workspace/file?filename=${encodeURIComponent(filename)}`);
      if (res.ok) {
        setFileContent(await res.text());
        setSelectedFile(filename);
      }
    } catch (e) {
      console.error('Failed to load file', e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || agentState !== 'idle') return;

    const msg = input;
    setInput('');
    
    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
      });
    } catch (e) {
      console.error('Failed to send message', e);
    }
  };

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-[#00ff00] font-mono overflow-hidden">
      {/* Sidebar: File Explorer */}
      <div className="w-64 border-r border-[#00ff00]/30 flex flex-col bg-[#050505]">
        <div className="p-4 border-b border-[#00ff00]/30 flex items-center gap-2 font-bold tracking-widest uppercase">
          <HardDrive size={18} />
          <span>Workspace</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {files.map(f => (
            <button
              key={f}
              onClick={() => loadFile(f)}
              className={`w-full text-left px-2 py-1 text-sm flex items-center gap-2 hover:bg-[#00ff00]/10 transition-colors ${selectedFile === f ? 'bg-[#00ff00]/20 text-white' : 'text-[#00ff00]/80'}`}
            >
              {f.includes('/') ? <Folder size={14} /> : <FileText size={14} />}
              <span className="truncate">{f}</span>
            </button>
          ))}
        </div>
        
        {/* Agent Status */}
        <div className="p-4 border-t border-[#00ff00]/30 bg-[#0a0a0a]">
          <div className="text-xs uppercase tracking-widest text-[#00ff00]/50 mb-2">Engine Status</div>
          <div className="flex items-center gap-3 mb-4">
            <Cpu size={20} className={agentState === 'running' ? 'animate-pulse text-yellow-400' : 'text-[#00ff00]'} />
            <span className={`text-sm font-bold uppercase ${agentState === 'running' ? 'text-yellow-400' : 'text-[#00ff00]'}`}>
              {agentState}
            </span>
          </div>
          
          <div className="text-xs uppercase tracking-widest text-[#00ff00]/50 mb-1 mt-2">State Register (q)</div>
          <div className="text-xs text-yellow-400 font-bold break-words">{qState}</div>

          <div className="text-xs uppercase tracking-widest text-[#00ff00]/50 mb-1 mt-4">Head Pointer (d)</div>
          <div className="text-xs text-cyan-400 font-bold break-words">{dState}</div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Top bar */}
        <div className="h-12 border-b border-[#00ff00]/30 flex items-center px-4 justify-between bg-[#050505]">
          <div className="flex items-center gap-2 font-bold tracking-widest uppercase">
            <Terminal size={18} />
            <span>TuringClaw // The Infinite Tape</span>
          </div>
          <div className="text-xs text-[#00ff00]/50">Strict Discipline Enforced</div>
        </div>

        {/* Split View: Tape vs File Viewer */}
        <div className="flex-1 flex overflow-hidden">
          {/* The Tape */}
          <div className={`flex-1 flex flex-col ${selectedFile ? 'border-r border-[#00ff00]/30' : ''}`}>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-sm leading-relaxed tape-container">
              <div className="prose prose-invert prose-p:text-[#00ff00] prose-headings:text-[#00ff00] prose-a:text-yellow-400 prose-code:text-red-400 prose-pre:bg-[#050505] prose-pre:border prose-pre:border-[#00ff00]/30 max-w-none">
                <Markdown>{tape}</Markdown>
              </div>
              <div ref={tapeEndRef} />
            </div>
            
            {/* Input Area */}
            <div className="p-4 border-t border-[#00ff00]/30 bg-[#050505]">
              <form onSubmit={handleSubmit} className="flex gap-2">
                <span className="text-[#00ff00] font-bold mt-2">&gt;</span>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={agentState !== 'idle'}
                  placeholder={agentState === 'idle' ? "Write on the tape..." : "Agent is busy..."}
                  className="flex-1 bg-transparent border-none outline-none text-[#00ff00] placeholder-[#00ff00]/30 font-mono"
                  autoFocus
                />
                <button 
                  type="submit" 
                  disabled={agentState !== 'idle' || !input.trim()}
                  className="px-4 py-2 border border-[#00ff00]/50 hover:bg-[#00ff00]/20 disabled:opacity-50 disabled:cursor-not-allowed uppercase text-xs tracking-widest font-bold transition-colors"
                >
                  Append
                </button>
              </form>
            </div>
          </div>

          {/* File Viewer (Optional) */}
          {selectedFile && (
            <div className="w-1/3 flex flex-col bg-[#050505]">
              <div className="p-2 border-b border-[#00ff00]/30 flex justify-between items-center bg-[#0a0a0a]">
                <span className="text-xs font-bold text-yellow-400 truncate">{selectedFile}</span>
                <button onClick={() => setSelectedFile(null)} className="text-[#00ff00]/50 hover:text-white">
                  <Square size={14} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <pre className="text-xs text-[#00ff00]/80 font-mono whitespace-pre-wrap">
                  {fileContent}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
