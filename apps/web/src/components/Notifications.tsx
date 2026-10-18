import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";
import { Icon } from "./Icon.js";

interface Note {
  id: string;
  body: string;
  read: boolean;
}

/** A small bell with the agents' notes. Quiet hours are handled by the server. */
export function Notifications() {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      setNotes((await api<{ notifications: Note[] }>("GET", "/notifications")).notifications);
    } catch {
      /* Keep the latest notes if a background refresh fails. */
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const unread = notes.filter((n) => !n.read);
  const markRead = async () => {
    await Promise.all(
      unread.map((n) => api("POST", `/notifications/${n.id}/read`).catch(() => {})),
    );
    await load();
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("notes.label", { count: unread.length })}
        onClick={() => {
          setOpen(!open);
          if (!open) void markRead();
        }}
        className="notification-button"
      >
        <Icon name="bell" size={15} />
        <span className="notification-text">{t("notes.button")}</span>{" "}
        {unread.length > 0 && <span className="notification-count">{unread.length}</span>}
      </button>
      {open && (
        <ul className="notification-panel absolute right-0 z-50 mt-2 w-72 rounded-blob bg-panel p-3 text-ink shadow-soft">
          {notes.length === 0 && <li>{t("notes.empty")}</li>}
          {notes.map((n) => (
            <li key={n.id} className="border-b border-cream py-2 text-sm last:border-0">
              {n.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
