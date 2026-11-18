// TalkTrackDialog: the family's one talk-track panel (owner, 2026-11-13). A movable, resizable, pop-out-able
// FloatingDialog showing the presenter script; content comes from the lab. Shared service: vendor it, never edit
// a lab's copy. See shared/floating-dialog/README.md for the FloatingDialog behavior (drag, resize, pop out,
// Escape, saved position, narrow-screen sheet).
import FloatingDialog from "../floating-dialog/FloatingDialog";

export default function TalkTrackDialog({ isOpen, onClose, talk, title = "Talk track", storageKey = "talk-track-dialog" }) {
  const steps = Array.isArray(talk) ? talk : [];
  return (
    <FloatingDialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      ariaLabel="Talk track"
      defaultWidth={430}
      defaultHeight={null}
      placement="right"
      storageKey={storageKey}
      singletonKey="talk-track"
      testId="talk-track-dialog"
    >
      {steps.length === 0 ? (
        <p className="note">No script for this view.</p>
      ) : (
        <ol className="talk" data-testid="talk-track">
          {steps.map((t) => (
            <li key={t.id ?? t.title}>
              <h2>{t.title}</h2>
              <p>{t.say}</p>
            </li>
          ))}
        </ol>
      )}
    </FloatingDialog>
  );
}
