# deadline-ts
How to setup:
Use npm init roblox-ts.

Then add
```json
`{
	"include": [
		"src/**/*",
		"node_modules/@eves26phylum/types/global.d.ts"
	]
}`
```
to your tsconfig.json.
Use:
```json
    {   "compilerOptions": {
            "typeRoots": ["node_modules/@rbxts", "node_modules/@rbxts-js", "node_modules/@eves26phylum"],
        }
    }
```
Create a new file `/dog.json`
```json
{
    "scripts": {
        "build": "rbxtsc"
    }
}
```
Optional (but recommended):
in package.json:
```json
{
  "scripts": {
    "build": "npx deadline-dog",
    "watch": "rbxtsc -w"
  },
}
```
(watch support is coming later)