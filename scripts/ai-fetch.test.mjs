import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {
    NOT_COVERED_ANSWER,
    UNCLEAR_ANSWER,
    buildFetchPrompt,
    coverageMissNextStep,
    createWebFetchTool,
    fetchFocused,
    formatResultText,
    isAbstention,
    isExcerptInContent,
    normaliseSourceUrl,
    normaliseWhitespace,
    parseChildOutput,
    selectContent,
    verifyExcerpt,
    webFetchFailure
} from './ai-fetch.mjs'
import {noProgress} from './ai-subagent.mjs'

const model = {
    id: 'Qwen3.6-27B-UD-Q4_K_XL.gguf',
    name: 'Local AI',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 120_064
}

async function temporaryWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'gofer-fetch-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function usage() {
    return {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    }
}

function scriptedReader(text, {stopReason = 'stop'} = {}) {
    const contexts = []
    return {
        contexts,
        streamSimple: (requested, context) => {
            contexts.push(context)
            const message = {
                role: 'assistant',
                content: stopReason === 'error' ? [] : [{type: 'text', text}],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: usage(),
                stopReason,
                errorMessage: stopReason === 'error' ? text : undefined,
                timestamp: Date.now()
            }
            const stream = createAssistantMessageEventStream()
            queueMicrotask(() => {
                stream.push(
                    stopReason === 'error' ?
                        {type: 'error', reason: 'error', error: message}
                    :   {type: 'done', reason: stopReason, message}
                )
                stream.end(message)
            })
            return stream
        }
    }
}

function servedPage(markdown, {title = 'A page', finalUrl = 'https://example.com/p'} = {}) {
    const calls = []
    return {
        calls,
        fetchAndClean: url => {
            calls.push(url)
            return Promise.resolve({title, markdown, finalUrl})
        }
    }
}

test('a GitHub blob URL is rewritten to the raw file it hides', () => {
    assert.equal(
        normaliseSourceUrl('https://github.com/owner/repo/blob/main/src/index.ts'),
        'https://raw.githubusercontent.com/owner/repo/main/src/index.ts'
    )
    assert.equal(
        normaliseSourceUrl('https://github.com/o/r/blob/release/1.x/lib/a.ts?plain=1'),
        'https://raw.githubusercontent.com/o/r/release/1.x/lib/a.ts'
    )
})

test('every other URL is left exactly as it was', () => {
    const untouched = [
        'https://github.com/owner/repo',
        'https://github.com/owner/repo/tree/main/src',
        'https://github.com/owner/repo/blob/main',
        'https://raw.githubusercontent.com/owner/repo/main/a.ts',
        'https://example.com/blob/main/a.ts',
        'https://gitlab.com/owner/repo/blob/main/a.ts',
        'https://example.com/docs#install',
        'not a url at all'
    ]
    for (const url of untouched) assert.equal(normaliseSourceUrl(url), url)
})

test('a fragment anchors its own section, even past the head window', () => {
    const filler = `${'x'.repeat(30_000)}\n`
    const markdown =
        `# Top\n\nintro\n\n## Other[](#other)\n\n${filler}\n`
        + `## Target[](#the-target)\n\nthe answer is 42\n\n## After[](#after)\n\nunrelated tail\n`

    const selected = selectContent(markdown, 'https://example.com/docs#the-target')

    assert.equal(selected.section, 'the-target')
    assert.ok(selected.content.includes('the answer is 42'))
    assert.ok(!selected.content.includes('unrelated tail'))
    assert.ok(!selected.content.includes('intro'))
})

test('a fragment that names no heading falls back to the whole page', () => {
    const selected = selectContent('# Top\n\nbody text\n', 'https://example.com/d#gone')

    assert.equal(selected.section, undefined)
    assert.ok(selected.content.includes('body text'))
})

test('a fragment matches its own heading and not a longer one', () => {
    const markdown = '## Foobar[](#foobar)\n\nwrong section\n\n## Foo[](#foo)\n\nright section\n'

    assert.ok(selectContent(markdown, 'https://e.co/d#foo').content.includes('right section'))
    assert.ok(!selectContent(markdown, 'https://e.co/d#foo').content.includes('wrong section'))
    assert.ok(selectContent(markdown, 'https://e.co/d#foobar').content.includes('wrong section'))
})

test('a page over the budget keeps its head and its tail', () => {
    const selected = selectContent(`START${'x'.repeat(40_000)}END`, 'https://example.com/long')

    assert.ok(selected.content.startsWith('START'))
    assert.ok(selected.content.endsWith('END'))
    assert.ok(selected.content.includes('[...page continues, truncated...]'))
    assert.ok(selected.content.length < 40_000)
})

test('the shipped prompt carries the recalibrated rules and both sentinels', () => {
    const prompt = buildFetchPrompt({query: 'q', url: 'u', title: 't', content: 'c'})

    assert.match(prompt, /INCLUDING a partial/u)
    assert.ok(!prompt.includes('unclear, ambiguous, or absent'))
    assert.ok(prompt.includes(NOT_COVERED_ANSWER))
    assert.ok(prompt.includes(UNCLEAR_ANSWER))
    assert.match(prompt, /character-for-character/u)
    assert.match(prompt, /<question>q<\/question>/u)
    assert.match(prompt, /<page-content>\nc\n<\/page-content>/u)
})

test('an anchored section is announced to the reader', () => {
    const prompt = buildFetchPrompt({
        query: 'q',
        url: 'u',
        title: 't',
        content: 'c',
        section: 'install'
    })

    assert.match(prompt, /<page-section>/u)
    assert.match(prompt, /"#install" section/u)
    assert.ok(
        !buildFetchPrompt({query: 'q', url: 'u', title: 't', content: 'c'}).includes(
            '<page-section>'
        )
    )
})

test('the two tags are pulled back out', () => {
    const parsed = parseChildOutput(
        '  <answer>It is 42.</answer>\n<excerpt>the answer is 42</excerpt> '
    )

    assert.equal(parsed.answer, 'It is 42.')
    assert.equal(parsed.excerpt, 'the answer is 42')
})

test('a reply with no tags is taken whole rather than thrown away', () => {
    const parsed = parseChildOutput('  The page says it is 42.  ')

    assert.equal(parsed.answer, 'The page says it is 42.')
    assert.equal(parsed.excerpt, undefined)
})

test('a citation with no characters in it is no citation', () => {
    assert.equal(parseChildOutput('<answer>a</answer><excerpt>   </excerpt>').excerpt, undefined)
    assert.equal(parseChildOutput('<answer>a</answer><excerpt></excerpt>').excerpt, undefined)
})

test('a quote that is on the page verifies, and one that is not does not', () => {
    const page = 'The\ntimeout   defaults to 30 seconds.'

    assert.ok(isExcerptInContent('The timeout defaults to 30 seconds.', page))
    assert.ok(!isExcerptInContent('The timeout defaults to 60 seconds.', page))
})

test('a whitespace-only quote verifies against nothing', () => {
    for (const blank of ['   ', '\n', '\t \n ', '']) {
        assert.equal(isExcerptInContent(blank, 'any content whatsoever'), false)
        assert.equal(verifyExcerpt(blank, 'any content whatsoever').verified, false)
    }
})

test('the verdict and its evidence never disagree', () => {
    const page = 'ROUTER.ROUTE is the constant.'
    for (const excerpt of ['ROUTER.ROUTE', 'router.route', 'absent text', '  ']) {
        assert.equal(verifyExcerpt(excerpt, page).verified, isExcerptInContent(excerpt, page))
    }
    assert.equal(isExcerptInContent('router.route', page), false)
})

test('a failed verification keeps enough to diagnose it later', () => {
    const check = verifyExcerpt('  invented   quote  ', 'The real page said something else.')

    assert.equal(check.verified, false)
    assert.equal(check.normalisedExcerpt, 'invented quote')
    assert.equal(check.contentLength, 'The real page said something else.'.length)
    assert.match(check.contentSha256, /^[0-9a-f]{64}$/u)
})

test('the hash is of the normalised content, whatever was searched for in it', () => {
    const a = verifyExcerpt('one', 'the   page\ntext')
    const b = verifyExcerpt('another', 'the page text')

    assert.equal(a.contentSha256, b.contentSha256)
    assert.equal(normaliseWhitespace('the   page\ntext'), 'the page text')
})

test('an abstention counts however the reader wraps it', () => {
    assert.ok(isAbstention(UNCLEAR_ANSWER))
    assert.ok(isAbstention('Unclear from this page — the docs do not say.'))
    assert.ok(isAbstention('<answer>unclear from this page</answer>'))
    assert.ok(isAbstention('unclear  from   this  page'))
})

test('a real answer is not an abstention, and neither is the other sentinel', () => {
    assert.ok(!isAbstention('The timeout defaults to 30 seconds.'))
    assert.ok(!isAbstention(NOT_COVERED_ANSWER))
    assert.ok(!isAbstention('The wording here is unclear, but the default is 30.'))
})

test('the next step names the URL actually read', () => {
    const same = coverageMissNextStep('https://example.com/d', 'https://example.com/d')
    assert.match(same, /do not re-read it/u)
    assert.ok(!same.includes('GitHub file viewer'))

    const rewritten = coverageMissNextStep(
        'https://github.com/o/r/blob/main/a.ts',
        'https://raw.githubusercontent.com/o/r/main/a.ts'
    )
    assert.match(rewritten, /GitHub file viewer/u)
    assert.match(rewritten, /raw\.githubusercontent\.com\/o\/r\/main\/a\.ts/u)
    assert.ok(!rewritten.includes('try https://'))
})

test('an unverified quote is shown with a warning, not silently dropped', () => {
    const warned = formatResultText({answer: 'It is 42.', excerpt: 'invented'}, false)

    assert.match(warned, /WARNING/u)
    assert.match(warned, /remembered rather than read/u)
    assert.match(warned, /> invented/u)

    const clean = formatResultText({answer: 'It is 42.', excerpt: 'the answer is 42'}, true)
    assert.ok(!clean.includes('WARNING'))
    assert.match(clean, /Source excerpt:\n> the answer is 42/u)

    assert.equal(formatResultText({answer: 'It is 42.'}, undefined), 'It is 42.')
})

test('a page is read by a child that holds no tools at all', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('# Docs\n\nThe timeout defaults to 30 seconds.\n')
    const reader = scriptedReader(
        '<answer>30 seconds.</answer><excerpt>The timeout defaults to 30 seconds.</excerpt>'
    )

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://example.com/p',
        query: 'What is the default timeout?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.equal(result.answer, '30 seconds.')
    assert.equal(result.excerptVerified, true)
    assert.equal(result.coverageMiss, false)
    assert.equal(result.nextStep, undefined)
    assert.deepEqual(reader.contexts[0].tools, [])
    assert.match(result.prompt, /The timeout defaults to 30 seconds\./u)
})

test('a made-up quote comes back marked as one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('The timeout defaults to 30 seconds.')
    const reader = scriptedReader(
        '<answer>60 seconds.</answer><excerpt>The timeout defaults to 60 seconds.</excerpt>'
    )

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://example.com/p',
        query: 'What is the default timeout?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.equal(result.excerptVerified, false)
    assert.equal(result.excerptCheck.normalisedExcerpt, 'The timeout defaults to 60 seconds.')
})

test('a page about something else reports a coverage miss, and says what to do', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('This page documents version 2.')
    const reader = scriptedReader(
        `<answer>${NOT_COVERED_ANSWER}</answer><excerpt>This page documents version 2.</excerpt>`
    )

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://example.com/v2',
        query: 'What changed in version 5?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.equal(result.coverageMiss, true)
    assert.match(result.nextStep, /do not re-read it/u)
})

test('a sourced answer that merely mentions the sentinel is not a coverage miss', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('add_audio() exists. remove_audio() is documented elsewhere.')
    const reader = scriptedReader(
        '<answer>add_audio() exists; remove_audio() is not covered by this page.</answer>'
            + '<excerpt>add_audio() exists.</excerpt>'
    )

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://example.com/api',
        query: 'Do add_audio and remove_audio exist?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.equal(result.coverageMiss, false)
    assert.equal(result.nextStep, undefined)
})

test('the quote is checked against the whole page, not just the anchored section', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('# Top\n\nonly in the intro\n\n## Target[](#t)\n\nthe answer is 42\n')
    const reader = scriptedReader('<answer>42.</answer><excerpt>only in the intro</excerpt>')

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://example.com/d#t',
        query: 'What is the answer?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.equal(result.anchoredSection, 't')
    assert.ok(!result.prompt.includes('only in the intro'))
    assert.equal(result.excerptVerified, true)
})

test('the blob rewrite decides what is fetched, and the caller keeps its own URL', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('export const timeout = 30')
    const reader = scriptedReader(`<answer>${NOT_COVERED_ANSWER}</answer>`)

    const result = await fetchFocused({
        progress: noProgress,
        url: 'https://github.com/o/r/blob/main/a.ts',
        query: 'What is the timeout?',
        workspacePath: workspace.path,
        models: reader,
        model,
        fetchAndClean: page.fetchAndClean
    })

    assert.deepEqual(page.calls, ['https://raw.githubusercontent.com/o/r/main/a.ts'])
    assert.match(result.nextStep, /GitHub file viewer/u)
})

test('a URL that is not http is refused before anything is fetched', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const page = servedPage('never read')
    const tool = createWebFetchTool({
        workspacePath: workspace.path,
        models: scriptedReader('<answer>x</answer>'),
        model,
        fetchAndClean: page.fetchAndClean
    })

    for (const url of ['not a url', 'file:///etc/passwd', 'ftp://example.com/a']) {
        await assert.rejects(
            tool.execute('id', {url, query: 'anything'}, undefined),
            /not an http or https URL/u
        )
    }
    await assert.rejects(
        tool.execute('id', {url: 'https://example.com/p', query: '  '}, undefined),
        /no question to answer/u
    )
    assert.deepEqual(page.calls, [])
})

test('a page that cannot be fetched is reported as the site’s problem', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const tool = createWebFetchTool({
        workspacePath: workspace.path,
        models: scriptedReader('<answer>x</answer>'),
        model,
        fetchAndClean: async () => {
            const {FetchAndCleanError} = await import('./ai-web-clean.mjs')
            throw new FetchAndCleanError('Fetch failed: HTTP 404 Not Found for x', 'http-error')
        }
    })

    await assert.rejects(
        tool.execute('id', {url: 'https://example.com/gone', query: 'anything'}, undefined),
        /HTTP 404/u
    )
})

test('the tool proves itself before the turn, without a request leaving the machine', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    let fetched = 0
    const tool = createWebFetchTool({
        workspacePath: workspace.path,
        models: {
            streamSimple: () => {
                throw new Error('the probe must not reach a model')
            }
        },
        model,
        fetchAndClean: () => {
            fetched += 1
            throw new Error('the probe must not reach the network')
        }
    })

    const result = await tool.execute('reachability-probe', {probe: true}, undefined)

    assert.match(result.content[0].text, /web-fetch-reachable/u)
    assert.equal(fetched, 0)
})

test('a failed fetch says the material is still unread', () => {
    const message = webFetchFailure('it ran out of steps')

    assert.match(message, /still unread|treat the question as unanswered/u)
    assert.match(message, /different URL/u)
    assert.ok(!message.includes('read and bash'))
})
