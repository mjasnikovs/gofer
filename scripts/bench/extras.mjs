import {readFile} from 'node:fs/promises'
const SCRATCH = process.env.SCRATCH ?? import.meta.dirname
const tok = async content =>
    (
        await (
            await fetch('http://localhost:8080/tokenize', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({content})
            })
        ).json()
    ).tokens.length
const inv = await readFile(`${SCRATCH}/inventory.txt`, 'utf8')
const sentence =
    "The project's tracked files are listed below. Read them here rather than listing the project; list again only after you have written a file this list does not name.\n\n"
console.log('inventory block tokens:', await tok(sentence + inv))
