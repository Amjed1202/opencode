import { spawn } from "node:child_process"

const scenario = process.argv[2]
const command = process.argv.slice(3)
const secret = "private-fixture-value"
const signedOut = {
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
  analyticsDisabled: true,
  projectsDirectory: secret,
}
const status = JSON.stringify({
  ...signedOut,
  loggedIn: true,
  email: secret,
  accessToken: secret,
  unknown: { value: secret },
})

async function main() {
  if (scenario === "stdin-eof") {
    if ((await Bun.stdin.text()).length !== 0) {
      process.exitCode = 99
      return
    }
    process.stdout.write(status)
    return
  }
  if (scenario === "descendant") {
    spawn(process.execPath, [import.meta.filename, "hold-pipes"], {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      windowsHide: true,
      shell: false,
    }).unref()
    process.stdout.write("{}")
    return
  }
  if (scenario === "hold-pipes") {
    await Bun.sleep(1800)
    return
  }
  if (scenario === "hang") {
    await Bun.sleep(20000)
    return
  }
  if (scenario === "invalid-utf8") {
    process.stdout.write(Buffer.from([0xff]))
    return
  }
  if (scenario === "invalid-stderr") {
    process.stderr.write(Buffer.from([0xff]))
    process.stdout.write(status)
    return
  }
  if (scenario === "truncated-utf8") {
    process.stdout.write(Buffer.from([0xe2, 0x82]))
    return
  }
  if (scenario === "oversize-stdout") {
    process.stdout.write("x".repeat(4096))
    return
  }
  if (scenario === "oversize-stderr") {
    process.stderr.write(secret.repeat(300))
    process.stdout.write(status)
    return
  }
  if (scenario === "shared-budget") {
    process.stdout.write(JSON.stringify({ loggedIn: true, extra: "x".repeat(140) }))
    process.stderr.write("y".repeat(140))
    return
  }
  if (scenario === "stderr-private") {
    process.stderr.write(secret)
    process.stdout.write(status)
    return
  }
  if (scenario === "split-utf8") {
    const bytes = Buffer.from(JSON.stringify({ loggedIn: true, ignored: "é中🙂" }))
    for (const byte of bytes) {
      process.stdout.write(Buffer.from([byte]))
      await Bun.sleep(2)
    }
    return
  }
  if (scenario === "malformed") {
    process.stdout.write("{" + secret)
    return
  }
  if (scenario === "trailing") {
    process.stdout.write(status + "\n{}")
    return
  }
  if (scenario === "array") {
    process.stdout.write("[]")
    return
  }
  if (scenario === "null") {
    process.stdout.write("null")
    return
  }
  if (scenario === "missing") {
    process.stdout.write("{}")
    return
  }
  if (scenario === "wrong-type") {
    process.stdout.write('{"loggedIn":"true"}')
    return
  }
  if (scenario === "logged-in-exit-one") {
    process.stdout.write(status)
    process.exitCode = 1
    return
  }
  if (scenario === "logged-out-exit-zero") {
    process.stdout.write(JSON.stringify(signedOut))
    return
  }
  if (scenario === "wrong-exit") {
    process.stdout.write(status)
    process.exitCode = 2
    return
  }
  if (command.length === 1 && command[0] === "--version") {
    process.stdout.write(scenario === "wrong-version" ? "2.1.250 (Claude Code)\n" : "2.1.251 (Claude Code)\n")
    if (scenario === "version-exit-one") process.exitCode = 1
    return
  }
  if (command.length === 2 && command[0] === "auth" && command[1] === "status") {
    process.stdout.write(scenario === "logged-out" ? JSON.stringify(signedOut) : status)
    if (scenario === "logged-out") process.exitCode = 1
    return
  }
  process.stderr.write("Unexpected diagnostic command")
  process.exitCode = 99
}

await main()
