import { configFromEnv } from './config.ts'
import { createApp } from './app.ts'

let config
try {
  config = configFromEnv()
} catch (e) {
  console.error(`report-button: ${(e as Error).message}`)
  process.exit(1)
}

const server = createApp({ config })
server.listen(config.port, () => {
  console.log(
    `report-button listening on :${config.port}; issues -> ${config.github.repo}, ` +
      `screenshots -> ${config.github.assetRepo}@${config.github.assetBranch}`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
