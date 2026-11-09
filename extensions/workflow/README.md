# Workflow extension

`/workflow` is an opinionated dynamic-workflow control plane for Pi. It turns a decomposable request into an inspectable JavaScript program, routes subagents by semantic role, asks for approval, and runs the work in the background.

Requires Pi 0.80.10 or newer. The maintained **0.5.6-pt.1** child-capture build is validated with **Pi 1.5.0** and **pi-monitor 0.10.0**.

## Maintained child-capture compatibility build

This build is based on upstream commit `8a8ec30fff0341a1fc3159eaf367351c421f4b5d`; its original workflow sources match npm `pi-agent-extensions@0.5.6`. It keeps the original workflow extension and adds an optional SDK observer before each child prompt. The default entry discovers pi-monitor through `pi-monitor:workflow-observer:v1`; the bus exchanges only a version and callback registration. The actual SDK session goes directly to that callback. With no observer, workflow operation stays unchanged. Programmatic integrations may pass a typed `childObserver` to `createWorkflowExtension` or `WorkflowManager`; types live in `child-observer.ts`.

Children use actual SDK IDs and the original launching run's parent ID, captured before approval. A parent session change does not reparent background output. Each retry has its own SDK session; cached resume steps create no session or new captured usage. Resuming under a different caller keeps the run's original parent. Observer startup failure prevents that child prompt and follows the existing failed-agent/retry result handling. Observer teardown drains before child disposal, bounded to two seconds; asynchronous drain failure preserves inference results. The monitor independently limits its drain to 1.5 seconds and admits only company-provider records with request-bound served-account metadata.

Replace the original `pi-agent-extensions` package with this pinned compatibility build. Load exactly one workflow entry; installing both packages would register duplicate tools. For an unpublished local artifact:

```sh
npm ci
npm run test:workflow
npm run typecheck:workflow
npm test
npm pack --dry-run
npm pack
# On the producing host, extract the reviewed artifact into a dedicated directory:
mkdir -p "$HOME/.local/share/pi-workflow-0.5.6-pt.1"
tar -xzf pi-agent-extensions-0.5.6-pt.1.tgz -C "$HOME/.local/share/pi-workflow-0.5.6-pt.1"
# Remove the existing source as shown by pi list, then install the replacement:
pi remove npm:pi-agent-extensions
pi install "$HOME/.local/share/pi-workflow-0.5.6-pt.1/package"
```

Install the reviewed monitor 0.10.0 artifact on the same producing hosts and restart Pi. Existing running workflows cannot gain observers retroactively. This producer adds no browser completion/waiting state. Upstream MIT licensing and author attribution remain in the package.

The opt-in installed-SDK regression uses only scratch configuration, synthetic auth/providers, and localhost inference/upload services:

```sh
# PI_PKG must identify the package owned by the installed Pi launcher.
PI_COMPAT=1 PI_PKG="$pi_pkg" PI_MONITOR_SOURCE="$monitor_source" \
  node --import tsx --test tests/workflow/sdk-integration.test.ts
```

The fixture prints its scratch directory and retains `captured-records.json` and `workflow-evidence.json` for independent Worker hierarchy checks. It covers the managed workflow tool, company/private siblings, concurrent old/new parents, late background output, retry sessions, cached resume, original ancestry on invocation resume, and incompatible observer rejection. Normal tests also cover cancellation during attachment, pre-cancelled invocation, model/thinking/tool preservation, `noExtensions`, and bounded cleanup. No historical transcript is replayed.


## First run

```text
/workflow setup
/workflow doctor
/workflow run audit this repository from correctness, testing, and maintainability angles
```

`/workflow help` is the in-Pi user guide. `/workflow doctor` is a read-only readiness check for extension activation, project trust, model configuration and availability, saved workflows, and visible run history. Doctor makes no model calls, changes no settings, and starts no workflows.

Setup offers four profiles:

| Profile | Concurrency | Total agents | Intent |
|---|---:|---:|---|
| Lean | 3 | 8 | Cheap, focused fan-out |
| Balanced | 4 | 15 | Everyday default |
| Deep | 6 | 40 | Larger, higher-effort investigation |
| Custom | 1–16 | 1–1000 | Explicit routes and limits |

Each profile maps four roles to an authenticated model and thinking level:

* `scout` — inexpensive discovery and inventory
* `worker` — implementation and substantial analysis
* `reviewer` — independent criticism, preferably from another model family
* `synthesizer` — final integration and judgment

When routes are customized, the model picker starts from Pi's configured `enabledModels` scope and provides the same type-to-filter interaction as `/model`. This keeps provider catalogs with hundreds of entries out of the normal setup path.

## Storage

* Global control settings: `~/.pi/workflows/control-plane.json`
* Optional project settings: `.pi/workflow.json`
* Project workflows: `.pi/workflows/*.js`
* Personal workflows: `~/.pi/workflows/saved/*.js`
* Run journals and results: `~/.pi/workflows/projects/<project-hash>/runs/*.json`
* Exported reports: `~/.pi/workflows/projects/<project-hash>/exports/*.{md,html}`

Project workflow files override personal files with the same filename. Run state stays outside the repository.

Three built-in starting points are always available:

```text
/workflow saved code-review {"scope":"the current branch against main"}
/workflow saved repository-audit
/workflow saved migration-plan {"target":"move persistence from files to SQLite"}
```

A personal or project workflow with the same filename overrides the built-in.

## Run browser

`/workflow` opens the interactive run browser. `/workflow runs` and `/workflow history` open the same view, while `/workflow active` starts with the active filter selected. History is project-scoped across Pi sessions, so restarting Pi does not hide an earlier run.

Select a run and press Enter to inspect it. Completed runs open on the rendered Markdown result; running and paused runs open on progress. The detail view provides:

* phase progress, elapsed time, token usage, and cost
* complete agent prompts, recent tool activity, model routes, and results for newly recorded runs
* the generated JavaScript source
* copy, Markdown export, self-contained visual HTML save/open, and save-as-reusable-workflow actions
* pause, resume, and stop controls for live runs

Older persisted runs remain readable. Because their original schema did not retain agent prompts or tool activity, those two fields show a compatibility notice while their full results and usage remain available.

## JavaScript API

Workflow scripts begin with a literal metadata export and may use these globals. Metadata phases may be written as `{ title: "Inspect" }` objects or plain strings; orchestration may be top-level or wrapped in an async `run()` function. A trailing bare `run()` is normalized into an awaited call so its failures stay attached to the workflow run.

* `agent(prompt, { label, tier, model?, tools?, disallowedTools? })`
* `agent(persona, options)(task, overrides?)` for a reusable role
* `parallel(thunks)`
* `pipeline(items, ...stages)`
* `phase(title)` or `phase(title, async () => ...)`
* `log(message)`
* `retry(thunk, { attempts })`
* `gate(thunk, validator, { attempts })`
* `checkpoint(question)`
* `workflow(name, args)` for a saved nested workflow
* `budget`, `args`, and `cwd`

## Security model

Workflow execution requires Pi to mark the project as trusted. Before execution, approval opens on the complete line-numbered JavaScript; Tab switches to the model, scale, tools, and security summary. Only an explicit `y` starts the run. The runtime uses Node's `vm` to constrain the script's normal globals and improve determinism, but `vm` is not a security sandbox. Run only generated or saved workflow JavaScript you trust.

Subagents receive Pi's standard coding tools unless the script specifies a narrower `tools` allowlist. Repository writes are therefore possible and are called out in the approval preview.

Background completion and failure notices are display-only. They do not automatically wake the parent model, so an invalid workflow cannot enter a retry and re-approval loop on its own.
