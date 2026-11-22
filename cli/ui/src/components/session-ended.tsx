/** The original's session gate, in its words, for a tab the server no longer knows. */
export function SessionEnded() {
  return (
    <section
      role="alert"
      className="fixed inset-0 z-[1000] grid place-items-center bg-[#f4f6fa] p-6 text-[#172033]"
    >
      <div className="w-[min(100%,560px)] rounded-2xl border border-[#d7dce4] bg-white p-8 shadow-[0_12px_48px_#17203312]">
        <h1 className="mb-4 text-[24px] font-bold">Session ended</h1>
        <p className="my-3 text-[15px] leading-[1.6]">
          This browser has no active session, or the server was restarted. Your skills have not been
          removed.
        </p>
        <p className="my-3 text-[15px] leading-[1.6]">
          Run{" "}
          <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[13px]">aireg ui</code>{" "}
          again and use the tab it opens. Keep the launch address it prints private.
        </p>
      </div>
    </section>
  );
}
