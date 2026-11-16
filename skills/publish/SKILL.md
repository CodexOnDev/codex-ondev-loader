---
name: publish
description: Publish the user's own game or app to their GitHub account and get an omgithub page. Use after finishing a new app or game, or when the user asks to publish, share, or put their project online.
---

# Publish a game or app to GitHub

Publishing means: a public GitHub repo in the user's own account, a clean
README that omgithub renders, and a link. Never publish Codex ondev's own
source; only publish the project the user built in their workspace.

## 1. Sign in to GitHub

Check the login first:

    gh auth status

If that fails, use the gh-oauth-login skill and let the user finish the login
in the browser. Never ask the user to paste a token into the chat.

## 2. Look for secrets before anything becomes public

Scan the project and show the user what you found:

    node /opt/ondev/skills/publish/scripts/publish-check.mjs .

It lists .env files, key-like files, token patterns and oversized files. Ask the
user to confirm before the first public push when anything looks like a secret,
and never commit those files (add them to .gitignore).

## 3. Create the repository and push

    gh repo create USER/REPO --public --source . --remote origin --push

Use a short, readable repo name. If the repo already exists, push to it instead
of creating a second one.

## 4. README rules for omgithub

omgithub renders the README, so it must follow these rules:

- First line is `# Title`, at most 120 characters.
- The first paragraph is an introduction over 60 characters, plain text: no
  URL, not a list.
- Screenshots are README images with relative paths such as
  `![gameplay screenshot](screenshots/game.png)`; alt text must contain
  "screenshot" or "gameplay", the first one is the cover, at most 12 images.
- README under 512 KB, no single file over 100 MB.

## 5. Web game with index.html

Pin the Play link to the pushed commit:

    SHA=$(git rev-parse HEAD)
    # add to README: [Play](https://f.ondev.store/USER/REPO/blob/$SHA/)

Then set the homepage:

    gh repo edit USER/REPO --homepage "https://f.ondev.store/USER/REPO/blob/$SHA/"

## 6. Android app

Build or take the APK, then:

    gh release create v1 app.apk --repo USER/REPO --title "v1" --notes "First build"

Link the APK download from the README, because omgithub does not read releases:

    [Download the APK](https://github.com/USER/REPO/releases/download/v1/app.apk)

## 7. Optional polish

    gh repo edit USER/REPO --description "Short description"
    gh repo edit USER/REPO --add-topic game --add-topic android

## 8. Report the links

Return `https://omgithub.com/USER/REPO` and, for web games, the
`https://f.ondev.store/USER/REPO/blob/SHA/` Play link.

Tell the user:

- Sign in to omgithub.com with the same GitHub account so the page loads
  reliably.
- Changes can take a while to appear because of caching.
- Press Publish on the store page to list the project in the catalog.
