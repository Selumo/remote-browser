/// <reference path="../pb_data/types.d.ts" />

// Collections for the remote browser. Rules are null (superuser only): the app server is the only
// client and talks to PocketBase on 127.0.0.1 as a superuser. Dashboard sign-in uses the built-in
// `users` auth collection.

const autodates = () => [
  { name: "created", type: "autodate", onCreate: true, onUpdate: false },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
]

migrate(
  (app) => {
    const profiles = new Collection({
      type: "base",
      name: "profiles",
      fields: [
        { name: "name", type: "text", required: true, max: 100 },
        { name: "start_url", type: "url" },
        { name: "notes", type: "text", max: 2000 },
        ...autodates(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_profiles_name ON profiles (name)"],
    })
    app.save(profiles)

    const jobs = new Collection({
      type: "base",
      name: "jobs",
      fields: [
        { name: "name", type: "text", required: true, max: 100 },
        {
          name: "profile",
          type: "relation",
          collectionId: profiles.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { name: "steps", type: "json", maxSize: 200000 },
        ...autodates(),
      ],
      indexes: ["CREATE UNIQUE INDEX idx_jobs_name ON jobs (name)"],
    })
    app.save(jobs)

    const runs = new Collection({
      type: "base",
      name: "job_runs",
      fields: [
        {
          name: "job",
          type: "relation",
          collectionId: jobs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        {
          name: "status",
          type: "select",
          values: ["running", "success", "failed"],
          maxSelect: 1,
          required: true,
        },
        { name: "started", type: "date" },
        { name: "finished", type: "date" },
        { name: "error", type: "text", max: 5000 },
        ...autodates(),
      ],
      indexes: ["CREATE INDEX idx_job_runs_created ON job_runs (created)"],
    })
    app.save(runs)

    const logs = new Collection({
      type: "base",
      name: "job_logs",
      fields: [
        {
          name: "run",
          type: "relation",
          collectionId: runs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { name: "level", type: "select", values: ["info", "error"], maxSelect: 1 },
        { name: "message", type: "text", max: 10000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: ["CREATE INDEX idx_job_logs_run ON job_logs (run, created)"],
    })
    app.save(logs)

    // Dashboard accounts are created by the app (ADMIN_EMAIL) or a superuser, never by sign-up.
    const users = app.findCollectionByNameOrId("users")
    users.createRule = null
    app.save(users)
  },
  (app) => {
    for (const name of ["job_logs", "job_runs", "jobs", "profiles"]) {
      app.delete(app.findCollectionByNameOrId(name))
    }
    const users = app.findCollectionByNameOrId("users")
    users.createRule = ""
    app.save(users)
  },
)
