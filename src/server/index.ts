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
  const modes = [
    config.github && `token for ${config.github.repo} (screenshots -> ${config.github.assetRepo}@${config.github.assetBranch})`,
    config.app && `GitHub App ${config.app.slug} for any repo it is installed on`,
  ].filter(Boolean)
  console.log(`report-button listening on :${config.port}; ${modes.join('; ')}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
