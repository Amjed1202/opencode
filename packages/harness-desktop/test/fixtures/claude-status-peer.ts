const args = process.argv.slice(2)
if (args.join(" ") === "--version") process.stdout.write("2.1.251 (Claude Code)\n")
else if (args.join(" ") === "auth status")
  process.stdout.write(
    JSON.stringify({
      loggedIn: true,
      authMethod: "unknown-profile",
      apiProvider: "cloud",
      subscriptionType: "claimed-plan",
      email: "private-fixture-label",
      token: "private-fixture-value",
      projectsDirectory: "/private-fixture-path",
    }) + "\n",
  )
else process.exit(99)
export {}
