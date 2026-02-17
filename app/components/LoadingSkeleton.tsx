export function LoadingSkeleton({ width = "100%", height = "1rem", borderRadius = "4px" }: { width?: string; height?: string; borderRadius?: string }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        background: "linear-gradient(90deg, #F3F4F6 25%, #E5E7EB 50%, #F3F4F6 75%)",
        backgroundSize: "200% 100%",
        animation: "shimmer 1.5s infinite",
      }}
    >
      <style>{`
        @keyframes shimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
      `}</style>
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "1rem", marginBottom: "1rem" }}>
        {Array.from({ length: cols }).map((_, i) => (
          <LoadingSkeleton key={i} height="2rem" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "1rem", marginBottom: "0.75rem" }}>
          {Array.from({ length: cols }).map((_, j) => (
            <LoadingSkeleton key={j} height="1.5rem" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div style={{ padding: "1.5rem", backgroundColor: "#FFFFFF", border: "1px solid rgba(11,11,15,0.12)", borderRadius: "12px" }}>
      <LoadingSkeleton width="60%" height="1.5rem" borderRadius="4px" style={{ marginBottom: "1rem" }} />
      <LoadingSkeleton width="100%" height="2rem" borderRadius="4px" style={{ marginBottom: "0.5rem" }} />
      <LoadingSkeleton width="80%" height="1rem" borderRadius="4px" />
    </div>
  );
}

