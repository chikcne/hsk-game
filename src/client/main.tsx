import { Data, Effect } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/main.css";

class ApplicationRootError extends Data.TaggedError("ApplicationRootError")<{
  readonly message: string;
}> {}

const startApplication: Effect.Effect<void, ApplicationRootError, never> = Effect.gen(function* () {
  const root = document.getElementById("root");
  if (!root) {
    return yield* Effect.fail(new ApplicationRootError({ message: "Missing application root" }));
  }
  yield* Effect.sync(() => createRoot(root).render(<StrictMode><App /></StrictMode>));
});

Effect.runFork(startApplication.pipe(
  Effect.catchAll((error) => Effect.sync(() => console.error(error))),
));
