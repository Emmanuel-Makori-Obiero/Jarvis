import { Link } from "react-router-dom";

export default function Home() {
  return (
    <section className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm tracking-wide text-cyan-400 font-mono mb-4">
          Jarvis
        </p>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-6">
          Your assistant, everywhere you work
        </h1>
        <p className="text-neutral-400 mb-10">
          Jarvis runs on your desktop and your phone, keeping the same context
          wherever you are.
        </p>
        <Link
          to="/download"
          className="inline-flex items-center justify-center rounded-lg bg-cyan-500 px-6 py-3 text-sm font-medium text-neutral-950 hover:bg-cyan-400 transition-colors"
        >
          Download Jarvis
        </Link>
      </div>
    </section>
  );
}
