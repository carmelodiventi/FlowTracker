import { openAccessibilitySettings } from "../api";

interface Props {
  onDismiss: () => void;
}

export default function AccessibilityModal({ onDismiss }: Props) {
  const handleOpenSettings = async () => {
    await openAccessibilitySettings();
    // Dismiss after opening so the user can see the modal is gone when they
    // return to the app (re-check happens on next mount via App.tsx).
    onDismiss();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.80)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      {/* Card */}
      <div
        style={{
          background: "#000000",
          width: "100%",
          maxWidth: 400,
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 4px 40px rgba(0,0,0,0.6), 0 0 1px rgba(162,201,255,0.10)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "40px 40px 36px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          {/* Lock icon */}
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 40, color: "#a2c9ff", marginBottom: 20 }}
          >
            lock
          </span>

          <h1
            style={{
              color: "#ffffff",
              fontSize: 18,
              fontWeight: 500,
              letterSpacing: "-0.02em",
              marginBottom: 28,
              lineHeight: 1.4,
            }}
          >
            FlowTracker needs accessibility to work properly
          </h1>

          <div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 12 }}>
            <button
              onClick={handleOpenSettings}
              style={{
                width: "100%",
                padding: "12px 0",
                background: "#58a6ff",
                color: "#001c38",
                fontWeight: 700,
                fontSize: 14,
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                transition: "filter 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.1)")}
              onMouseLeave={(e) => (e.currentTarget.style.filter = "brightness(1)")}
            >
              Go to System Settings
            </button>

            <button
              onClick={onDismiss}
              style={{
                width: "100%",
                padding: "8px 0",
                background: "transparent",
                color: "#c0c7d4",
                fontWeight: 500,
                fontSize: 14,
                border: "none",
                cursor: "pointer",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#ffffff")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#c0c7d4")}
            >
              Not Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
