# Using Agentgate with Claude Desktop

Claude Desktop can use your Claude subscriptions in two ways. Pick one in the Agentgate app under **Claude Desktop**; you can switch back at any time and nothing is lost. Everything here works on this Mac only.

## The two ways

| | **Switch accounts** | **Share automatically** |
|---|---|---|
| Chat | Yes | Not available |
| Cowork | Yes | Not yet verified |
| Code tab | Yes | Yes |
| Your claude.ai history and projects | Yes | No: a separate local profile |
| When a subscription runs out | You switch (one click; Claude Desktop restarts) | Moves on to the next subscription by itself |
| Needs Agentgate running | Only to switch | Yes |

**Switch accounts** keeps Claude Desktop signed in to your normal Claude account. Agentgate keeps a saved login for each of your accounts on this Mac, so switching needs no password: Claude Desktop restarts and opens signed in to the other account.

**Share automatically** turns on Claude Desktop's gateway mode and points it at Agentgate. The Code tab then uses whichever subscription has room, exactly like Claude Code in the terminal does with Agentgate. Claude Desktop shows a separate profile in this mode, without Chat.

## Set up (no terminal needed)

1. Install and open the Agentgate app, and choose **Set up this machine**.
2. Answer **Where do you use Claude?** with *The Claude Desktop app*.
3. On the **Accounts** screen:
   - **Add your subscriptions** with **Add account**. One browser sign-in per account. Agentgate uses it to show each account's limits.
   - **Connect each account to Claude Desktop** (Switch accounts only). Choose **Connect to Claude Desktop** from the account's ⋯ menu: Claude Desktop restarts signed out, you sign in with that account, and Agentgate saves the login by itself. The account Claude Desktop already had is saved first.
   - **Pick the account** with **Claude uses** under Claude. Claude Code and Claude Desktop both move to it; Desktop restarts. *Automatic* lets Claude Code move between accounts and leaves Desktop where it is. To share automatically in the Code tab instead, use the menu bar.

## Every day

- The **menu bar** shows the account Claude Desktop uses and how much of its limit is used ("✳ Work 62%"). Pick another account there to switch.
- When Claude Desktop's account is close to its limit, the Accounts screen suggests an account with room, and you get a notification when it runs out.
- If a saved login hasn't been used for a few weeks it expires. Agentgate tells you a few days before; using that account in Claude Desktop once keeps it connected.

## Good to know

- **Don't use Log out in Claude Desktop.** Signing out ends that login for good, including Agentgate's saved copy. To add or change accounts, use **Connect to Desktop** in Agentgate; it signs Claude Desktop out on this Mac only.
- **Switching restarts Claude Desktop.** Running Cowork and Code sessions stop, and messages you haven't sent yet are lost.
- **MCP servers.** Turn on *Use Agentgate's MCP servers in the Code tab* to get your MCP servers and per-repository tools in Claude Desktop's Code tab (both modes). Chat and Cowork don't load them.
- **Your data.** Saved logins stay on this Mac, encrypted with its keychain, and are never synced to other machines. Before its first change, Agentgate backs up Claude Desktop's files to `~/.config/agentgate/desktop-backup/`.
- **Removing Agentgate.** Claude Desktop keeps the account it was last switched to. If you use *Share automatically*, switch back to your own sign-in first.
- **Rules.** Agentgate only uses accounts you sign in to yourself, and only sends Claude Code requests with subscription logins. The terms of each plan still apply.

## From the command line

```sh
agentgate desktop                    # mode, account in use, saved logins
agentgate desktop add [email]        # sign Desktop out on this Mac and save the next sign-in
agentgate desktop use <account>      # switch (label, email, pool id or uuid)
agentgate desktop capture            # save the login Desktop has now
agentgate desktop forget <account>
agentgate desktop gateway on|off     # share automatically in the Code tab
agentgate setup --mcp [off]          # MCP servers in Claude Code and Desktop's Code tab
```
