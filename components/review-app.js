"use client";

import { useEffect, useRef, useState } from "react";

const initialStatus = "Enter a URL to get started";

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function ReviewApp() {
  const iframeRef = useRef(null);
  const loadRequestRef = useRef(0);
  const [url, setUrl] = useState("");
  const [frameSrc, setFrameSrc] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [mode, setMode] = useState("browse");
  const [status, setStatus] = useState(initialStatus);
  const [currentUrl, setCurrentUrl] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [pins, setPins] = useState([]);
  const [activeTab, setActiveTab] = useState("active");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeCard, setActiveCard] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const activePins = pins.filter((pin) => !pin.resolved);
  const resolvedPins = pins.filter((pin) => pin.resolved);
  const visiblePins = activeTab === "active" ? activePins : resolvedPins;

  function sendToIframe(message) {
    try {
      iframeRef.current?.contentWindow?.postMessage(message, "*");
    } catch {}
  }

  async function loadUrl() {
    const requestId = Date.now();
    loadRequestRef.current = requestId;
    let targetUrl = url.trim();
    if (!targetUrl) return;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
      setUrl(targetUrl);
    }

    setIsLoading(true);
    setStatus("Loading...");
    setPins([]);
    setActiveCard(null);
    setFrameSrc("");
    setFrameKey((value) => value + 1);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = await response.json();
      if (loadRequestRef.current !== requestId) return;
      if (!response.ok) {
        throw new Error(data.error || "Unable to create session");
      }

      setCurrentSessionId(data.id);
      setCurrentUrl(targetUrl);
      setFrameSrc(data.proxyPath);
    } catch (error) {
      if (loadRequestRef.current !== requestId) return;
      setStatus(`Error: ${error.message}`);
      setIsLoading(false);
    }
  }

  function updateMode(nextMode) {
    setMode(nextMode);
    setStatus(
      nextMode === "comment"
        ? "Click anywhere to leave a comment"
        : currentUrl
          ? `OK ${currentUrl}`
          : initialStatus,
    );
    sendToIframe({ __markupType: "SET_MODE", mode: nextMode });
  }

  function togglePin(id, resolved) {
    setPins((currentPins) =>
      currentPins.map((pin) => (pin.id === id ? { ...pin, resolved } : pin)),
    );
    sendToIframe({ __markupType: "UPDATE_PIN", id, resolved });
  }

  function deletePin(id) {
    setPins((currentPins) => currentPins.filter((pin) => pin.id !== id));
    if (activeCard === id) setActiveCard(null);
    sendToIframe({ __markupType: "DELETE_PIN", id });
  }

  function highlightPin(id) {
    setActiveCard(id);
    sendToIframe({ __markupType: "HIGHLIGHT_PIN", id });
  }

  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html:
            "if (window !== window.top) { document.documentElement.innerHTML = ''; throw 0; }",
        }}
      />
      <div className="review-shell">
        <header className="toolbar">
          <span className="logo">Testing Review</span>
          <input
            className="url-input"
            type="text"
            placeholder="Enter URL... e.g. https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") loadUrl();
            }}
          />
          <button
            className="btn btn-primary"
            onClick={loadUrl}
            disabled={isLoading}
          >
            {isLoading ? "Loading..." : "Load"}
          </button>
          <div className="mode-toggle">
            <button
              className={`mode-btn ${mode === "browse" ? "active" : ""}`}
              onClick={() => updateMode("browse")}
              type="button"
            >
              Browse
            </button>
            <button
              className={`mode-btn ${mode === "comment" ? "active" : ""}`}
              onClick={() => updateMode("comment")}
              type="button"
            >
              Comment
            </button>
          </div>
          <span className="toolbar-status">{status}</span>
        </header>

        <main className="main">
          <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
            <div className="sidebar-header">
              <div className="sidebar-site">
                {currentUrl ? new URL(currentUrl).hostname : "-"}
              </div>
              {currentSessionId && (
                <div className="sidebar-subtitle">Session {currentSessionId}</div>
              )}
            </div>
            <div className="sidebar-tabs">
              <button
                className={`sidebar-tab ${activeTab === "active" ? "active" : ""}`}
                onClick={() => setActiveTab("active")}
                type="button"
              >
                Active
                <span className={`sidebar-count ${activePins.length ? "has-items" : ""}`}>
                  {activePins.length}
                </span>
              </button>
              <button
                className={`sidebar-tab ${activeTab === "resolved" ? "active" : ""}`}
                onClick={() => setActiveTab("resolved")}
                type="button"
              >
                Resolved
                <span
                  className={`sidebar-count ${resolvedPins.length ? "has-items" : ""}`}
                >
                  {resolvedPins.length}
                </span>
              </button>
            </div>
            <div className="comments-list">
              {!visiblePins.length ? (
                <div className="empty-comments">
                  <div className="empty-comments-icon">+</div>
                  <div>
                    Switch to <strong>Comment</strong> mode and click anywhere to
                    leave a note
                  </div>
                </div>
              ) : (
                visiblePins.map((pin) => (
                  <article
                    key={pin.id}
                    className={`comment-card ${activeCard === pin.id ? "active" : ""}`}
                    onClick={(event) => {
                      if (event.target.closest(".comment-action-btn")) return;
                      highlightPin(pin.id);
                    }}
                  >
                    <div className="comment-card-header">
                      <div className={`comment-pin-badge ${pin.resolved ? "resolved" : ""}`}>
                        {pin.number}
                      </div>
                      <span className="comment-author">{pin.author || "You"}</span>
                      <span className="comment-time">{timeAgo(pin.timestamp)}</span>
                    </div>
                    <div
                      className="comment-text"
                      dangerouslySetInnerHTML={{ __html: escapeHtml(pin.comment) }}
                    />
                    <div className="comment-actions">
                      {pin.resolved ? (
                        <button
                          className="comment-action-btn"
                          onClick={() => togglePin(pin.id, false)}
                          type="button"
                        >
                          Reopen
                        </button>
                      ) : (
                        <button
                          className="comment-action-btn"
                          onClick={() => togglePin(pin.id, true)}
                          type="button"
                        >
                          Resolve
                        </button>
                      )}
                      <button
                        className="comment-action-btn delete"
                        onClick={() => deletePin(pin.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </aside>

          <section className="iframe-area">
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              type="button"
              title="Toggle sidebar"
            >
              {sidebarOpen ? "<" : ">"}
            </button>

            <div className={`iframe-wrap ${mode === "comment" ? "comment-mode" : ""}`}>
              {!currentUrl && (
                <div className="empty-state">
                  <div className="empty-state-icon">[]</div>
                  <h2>Testing Review</h2>
                  <p>Enter any URL above and click Load</p>
                </div>
              )}
              <iframe
                key={frameKey}
                ref={iframeRef}
                id="proxyFrame"
                src={frameSrc}
                sandbox="allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-presentation allow-popups allow-popups-to-escape-sandbox"
                onLoad={() => {
                  setIsLoading(false);
                  setStatus(currentUrl ? `OK ${currentUrl}` : initialStatus);
                  sendToIframe({ __markupType: "SET_MODE", mode });
                }}
              />
            </div>
          </section>
        </main>
      </div>
      <MessageBridge
        onIframeReady={() => {
          sendToIframe({ __markupType: "SET_MODE", mode });
          if (pins.length) {
            sendToIframe({ __markupType: "LOAD_PINS", pins });
          }
        }}
        onPinCreated={(pin) => {
          const nextPin = {
            ...pin,
            resolved: false,
            author: "You",
            timestamp: Date.now(),
          };
          setPins((currentPins) => [...currentPins, nextPin]);
          setActiveCard(nextPin.id);
          if (!sidebarOpen) setSidebarOpen(true);
        }}
      />
    </>
  );
}

function MessageBridge({ onIframeReady, onPinCreated }) {
  useEffect(() => {
    function handleMessage(event) {
      if (!event.data || !event.data.__markupType) return;
      if (event.data.__markupType === "IFRAME_READY") {
        onIframeReady();
      }
      if (event.data.__markupType === "PIN_CREATED") {
        onPinCreated(event.data.pin);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [onIframeReady, onPinCreated]);

  return null;
}
