# Modern TypeScript Project Setup

A step-by-step guide to setting up a modern npm and TypeScript project from scratch.

## Step 1: Initialize npm

```bash
npm init -y
```

Creates a `package.json` with default values.

## Step 2: Install TypeScript

```bash
npm install -D typescript @types/node tsx
```

- `typescript` - The TypeScript compiler
- `@types/node` - Type definitions for Node.js
- `tsx` - Fast TypeScript executor (alternative to ts-node)

## Step 3: Initialize TypeScript

```bash
npx tsc --init
```

Creates `tsconfig.json` with recommended compiler options.

## Step 4: Configure package.json

Add scripts for development:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

## Step 5: Create source directory

```bash
mkdir src
# Create src/index.ts with your editor and add:
# console.log("Hello, TypeScript!");
```

## Step 6: Create .gitignore

```bash
# Create .gitignore with your editor and add:
node_modules
dist
.env
```

## Run the project

```bash
npm run dev
```
