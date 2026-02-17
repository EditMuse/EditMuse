import { useState, useEffect } from "react";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

let toastListeners: Array<(toasts: Toast[]) => void> = [];
let toasts: Toast[] = [];

function notifyListeners() {
  toastListeners.forEach(listener => listener([...toasts]));
}

export function showToast(message: string, type: ToastType = "info", duration: number = 5000) {
  const id = Math.random().toString(36).substring(7);
  const toast: Toast = { id, message, type, duration };
  toasts.push(toast);
  notifyListeners();

  if (duration > 0) {
    setTimeout(() => {
      removeToast(id);
    }, duration);
  }

  return id;
}

export function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  notifyListeners();
}

export function ToastContainer() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (newToasts: Toast[]) => {
      setCurrentToasts(newToasts);
    };
    toastListeners.push(listener);
    setCurrentToasts([...toasts]);

    return () => {
      toastListeners = toastListeners.filter(l => l !== listener);
    };
  }, []);

  if (currentToasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: "400px",
      }}
    >
      {currentToasts.map((toast) => {
        const colors = {
          success: { bg: "#F0FDF4", border: "#10B981", text: "#059669", icon: "✓" },
          error: { bg: "#FEF2F2", border: "#EF4444", text: "#DC2626", icon: "✕" },
          warning: { bg: "#FFFBEB", border: "#F59E0B", text: "#D97706", icon: "⚠" },
          info: { bg: "#EFF6FF", border: "#3B82F6", text: "#1E40AF", icon: "ℹ" },
        };
        const color = colors[toast.type];

        return (
          <div
            key={toast.id}
            style={{
              padding: "1rem 1.25rem",
              backgroundColor: color.bg,
              border: `2px solid ${color.border}`,
              borderRadius: "12px",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              animation: "slideIn 0.3s ease-out",
            }}
          >
            <div style={{ fontSize: "1.25rem", color: color.border }}>{color.icon}</div>
            <div style={{ flex: 1, color: color.text, fontSize: "0.875rem", fontWeight: "500" }}>
              {toast.message}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              style={{
                background: "transparent",
                border: "none",
                color: color.text,
                cursor: "pointer",
                fontSize: "1.25rem",
                padding: "0",
                lineHeight: "1",
                opacity: 0.7,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.7";
              }}
            >
              ×
            </button>
            <style>{`
              @keyframes slideIn {
                from {
                  transform: translateX(100%);
                  opacity: 0;
                }
                to {
                  transform: translateX(0);
                  opacity: 1;
                }
              }
            `}</style>
          </div>
        );
      })}
    </div>
  );
}

