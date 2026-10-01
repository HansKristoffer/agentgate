import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** A titled group of rows, in the manner of System Settings. */
export function Panel({
  title,
  detail,
  action,
  foot,
  children,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {detail && <p>{detail}</p>}
        </div>
        {action}
      </div>
      <div className="group">{children}</div>
      {foot && <p className="group-foot">{foot}</p>}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Badge({
  children,
  good = false,
}: {
  children: ReactNode;
  good?: boolean;
}) {
  return <span className={`badge ${good ? "good" : ""}`}>{children}</span>;
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="tool-btn" aria-label="Close dialog" onClick={close}>
          <X size={16} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
