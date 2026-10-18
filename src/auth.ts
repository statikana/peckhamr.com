import { betterAuth } from "better-auth"
import { memoryAdapter } from "@better-auth/memory-adapter"
import { AUTH_SECRET } from "$app/env/private"

// TODO: swap memoryAdapter for the D1 adapter once the DB binding is wired up in wrangler.toml
export const auth = betterAuth({
	database: memoryAdapter({}),
	secret: AUTH_SECRET,
	socialProviders: {
		github: {
			clientId: "...",
			clientSecret: "..."
		}
	}
})
