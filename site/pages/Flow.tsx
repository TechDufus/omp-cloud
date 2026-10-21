interface FlowNode {
  id: string;
  x: number;
  y: number;
  title: string;
  subtitle: string;
}

interface FlowEdge {
  id: string;
  path: string;
  steps: string;
  label: string;
  x: number;
  y: number;
  anchor: "start" | "middle";
}

const NODES: readonly FlowNode[] = [
  { id: "a", x: 20, y: 40, title: "Your machine", subtitle: "omp + /cloud plugin" },
  { id: "s", x: 275, y: 40, title: "omp-cloud", subtitle: "API · runner · SQLite" },
  { id: "v", x: 530, y: 40, title: "vibemon", subtitle: "microVM pool" },
  { id: "vm", x: 530, y: 236, title: "microVM", subtitle: "omp --mode rpc-ui" },
  { id: "g", x: 275, y: 236, title: "auth gateway", subtitle: "per-thread token" },
  { id: "b", x: 20, y: 236, title: "auth broker", subtitle: "OAuth refresh" },
];

const EDGES: readonly FlowEdge[] = [
  { id: "e1", path: "M190 72 H275", steps: "1 4", label: "HTTP · TLS", x: 232, y: 62, anchor: "middle" },
  { id: "e2", path: "M445 72 H530", steps: "1 4", label: "E2B + envd", x: 487, y: 62, anchor: "middle" },
  { id: "e3", path: "M615 104 V236", steps: "1 4", label: "sandbox", x: 625, y: 170, anchor: "start" },
  { id: "e4", path: "M530 268 H445", steps: "2", label: "client token", x: 487, y: 258, anchor: "middle" },
  { id: "e5", path: "M275 268 H190", steps: "2", label: "OAuth", x: 232, y: 258, anchor: "middle" },
  { id: "e6", path: "M360 104 V236", steps: "2", label: "per-thread client", x: 370, y: 170, anchor: "start" },
];

const DOTS: readonly { step: number; path: string }[] = [
  { step: 1, path: "M190 72 H615 V236" },
  { step: 2, path: "M530 268 H190 H530" },
  { step: 4, path: "M615 236 V72 H190" },
];

/** The animated architecture diagram. client/flow.ts cycles `data-step` 1..4; the CSS in landing.css reads it. */
export function Flow() {
  return (
    <figure className="flow" data-step="1">
      <svg
        viewBox="0 0 720 340"
        role="img"
        aria-label="omp-cloud architecture: your omp talks to the omp-cloud service, which runs each thread in a vibemon microVM; the VM reaches models through omp's auth gateway and broker."
      >
        {EDGES.map((edge) => (
          <path key={edge.id} className="flow-edge" d={edge.path} data-steps={edge.steps} />
        ))}
        {EDGES.map((edge) => (
          <text key={edge.id} className="flow-label" x={edge.x} y={edge.y} textAnchor={edge.anchor}>
            {edge.label}
          </text>
        ))}
        {NODES.map((node) => (
          <g key={node.id} className="flow-node" data-node={node.id}>
            <rect x={node.x} y={node.y} width={170} height={64} rx={10} />
            <text className="flow-title" x={node.x + 14} y={node.y + 27}>
              {node.title}
            </text>
            <text className="flow-sub" x={node.x + 14} y={node.y + 46}>
              {node.subtitle}
            </text>
          </g>
        ))}
        <text className="flow-badge" x={700} y={228} textAnchor="end">
          paused
        </text>
        <g className="flow-branch">
          <rect x={20} y={120} width={122} height={24} rx={12} />
          <text x={81} y={136} textAnchor="middle">
            {"omp-cloud/<id>"}
          </text>
        </g>
        {DOTS.map((dot) => (
          <circle key={dot.step} className="flow-dot" data-step={dot.step} r={4}>
            <animateMotion dur="2.4s" repeatCount="indefinite" path={dot.path} />
          </circle>
        ))}
      </svg>
    </figure>
  );
}
