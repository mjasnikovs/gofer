export const NO_THINK = '\n\n/no_think'

export function appendNoThink(prompt) {
    return `${prompt}${NO_THINK}`
}

function block(heading, body) {
    const text = (body ?? '').trim()
    return text.length === 0 ? '' : `${heading}\n${text}\n\n`
}

const PRESERVE_EXISTING =
    'EXISTING FILES — AUTHORITATIVE. The files shown below already exist. They override any '
    + '"create", "set up", "scaffold", "initialise", "only" or "exactly" wording in the task. Where '
    + 'the task names something that already exists, your GOAL and CONSTRAINTS must describe an '
    + 'in-place change that PRESERVES what is there and adds only the difference the task asks for. '
    + 'Never write a constraint that empties, replaces wholesale, or reduces an existing file to a '
    + 'fixed minimal set. Something already in the project is never scope creep.'

function picturesNote(count) {
    if (!count) return ''
    return (
        `This task comes with ${String(count)} attached image${count === 1 ? '' : 's'}. They are `
        + 'part of the task, not decoration. You are the only step that can see them: describe what '
        + 'they show, in words, inside GOAL and CONSTRAINTS. Anything you leave in the picture is '
        + 'lost.\n\n'
    )
}

export function refinePrompt(raw, {existingFiles, planContext, pictures = 0} = {}) {
    return (
        'Rewrite one development task as an unambiguous, self-contained statement. You are preparing '
        + 'work for a Godot project. Read files if you need to; change nothing.\n\n'
        + 'Answer in exactly these three sections, in this order, with the headings bare on their '
        + 'own lines and nothing before the first one:\n\n'
        + 'GOAL\n'
        + 'One paragraph. What will be true when this is done, in the terms of this project.\n\n'
        + 'CONSTRAINTS\n'
        + '- One rule per line, each checkable by looking at the result.\n\n'
        + 'KNOWN-UNKNOWNS\n'
        + '- One per line: something you could not settle from the task text alone.\n'
        + '- Write "(none)" if there are none.\n\n'
        + 'Do not write code. Do not restate the task. Do not add sections.\n\n'
        + picturesNote(pictures)
        + block(
            'PLAN CONTEXT — the other steps of this plan, which this task must NOT do:',
            planContext
        )
        + block(PRESERVE_EXISTING, existingFiles)
        + `TASK\n${raw}`
    )
}

const WORKER_RULES =
    'You are gathering INPUTS for somebody else to work from. Do not solve the task, do not write '
    + 'code, and do not propose a design. Emit only the section below — no preamble, no closing '
    + 'summary, no code fences, no markdown headings of your own.\n'
    + 'Only what THIS task touches. Leave everything else out; a shorter true answer beats a longer '
    + 'complete one.\n'
    + 'If there is genuinely nothing to report, answer exactly `(none)` and stop.'

export function filesPrompt(refined, {inventory} = {}) {
    return (
        `${WORKER_RULES}\n\n`
        + 'Your job is PATHS. Which files this task reads, changes or creates.\n\n'
        + 'Format — one file per line, two spaces between the path and the reason. The paths in the '
        + "example belong to another project; write this one's:\n"
        + 'FILES\n'
        + '  player/player.gd  holds the movement code the task changes\n'
        + '  ui/pause.tscn  does not exist yet; the task creates it\n\n'
        + block('PROJECT FILES', inventory)
        + `TASK\n${refined}`
    )
}

export function apisPrompt(refined, {inventory, files, canSearch} = {}) {
    return (
        `${WORKER_RULES}\n\n`
        + 'Your job is SYMBOLS. The exact signatures, class names, node types, signals and settings '
        + 'this task has to get right.\n\n'
        + 'Look every one of them up before you write it. Use godot_docs_search for engine classes '
        + 'and read or grep for anything in this project. Do not write a signature from memory — a '
        + 'plausible wrong signature costs more than an absent one.\n\n'
        + 'Format — one symbol per line, two spaces between the symbol and what it is:\n'
        + 'APIS\n'
        + '  CharacterBody2D.move_and_slide()  moves the body using velocity; no arguments in 4.x\n'
        + '  Input.is_action_just_pressed(action: StringName) -> bool  edge-triggered, not held\n\n'
        + (canSearch ?
            'If a fact might have changed since you were trained — an engine version, a class that '
            + 'moved, a method that was renamed — search the web for it rather than recalling it. '
            + 'Skip the web entirely for anything this project or the Godot documentation already '
            + 'answers.\n\n'
        :   '')
        + block('PROJECT FILES', inventory)
        + block('FILES THIS TASK TOUCHES — start here rather than looking for them again:', files)
        + `TASK\n${refined}`
    )
}

export function contextPrompt(refined, {inventory} = {}) {
    return (
        `${WORKER_RULES}\n\n`
        + 'Your job is HOW THIS PROJECT WORKS where the task touches it. Structure, conventions, and '
        + 'the decisions already made that this task has to live with.\n\n'
        + 'One claim per line, each starting with "- ". State something as fact only if you read it '
        + 'in this project. Anything you believe but did not read starts with "unverified:".\n\n'
        + 'Format — the example is another project; write claims about this one:\n'
        + 'CONTEXT\n'
        + '- every scene under levels/ instances player/player.tscn rather than its own\n'
        + '- unverified: input actions look like they are defined in the project settings, not code\n\n'
        + block('PROJECT FILES', inventory)
        + `TASK\n${refined}`
    )
}

export function toolingPrompt(goal) {
    return (
        `${WORKER_RULES}\n\n`
        + 'Your job is VERIFICATION. The commands this project already has that would show this work '
        + 'is correct.\n\n'
        + 'Only commands this project really defines — read the manifest and the scripts rather than '
        + 'guessing conventional names. A command that does not exist is worse than no command.\n\n'
        + 'A Godot project usually defines none of its own, and still has two that always work. '
        + 'List whichever of these this project can run:\n'
        + '  godot --headless --import  every asset resolves\n'
        + '  godot --headless --audio-driver Dummy --fixed-fps 60 --quit-after 600  the project '
        + 'boots and runs\n'
        + 'Say of the second that its exit code is 0 even when it prints errors, so its OUTPUT is '
        + 'what decides, not its status.\n\n'
        + 'Format — one command per line, two spaces between it and what it proves. The example is '
        + "another project's command; never emit it here:\n"
        + 'TOOLING\n'
        + '  make test  runs the project test suite\n\n'
        + `TASK\n${goal}`
    )
}

export function scopedGoal(refined) {
    const match = /^GOAL[ \t]*\n([\s\S]*?)(?=\n[A-Z][A-Z][A-Z -]*[ \t]*\n|$(?![\s\S]))/mu.exec(
        refined
    )
    if (!match) return refined
    const goal = match[1].trim()
    const bullet = goal.search(/\n[ \t]*[-*]\s/u)
    return bullet === -1 ? goal : goal.slice(0, bullet).trim()
}

export function grillPrompt(refined, research, {asked} = {}) {
    return (
        'You are finding the questions that must be settled before this task can be specified. Ask '
        + 'only what the research below does not already answer and what would change what gets '
        + 'built. Do not ask about style, naming, or anything you could decide yourself.\n\n'
        + 'Ask ONE question. Format, exactly:\n\n'
        + 'QUESTION: <the question, one sentence>\n'
        + 'A: <the option you recommend>\n'
        + 'B: <the realistic alternative>\n'
        + 'WHY: <one sentence on what turns on this>\n\n'
        + 'If everything that matters is already settled, answer exactly `NONE` and nothing else.\n\n'
        + block('ALREADY ASKED — do not ask any of these again, in any wording:', asked)
        + `RESEARCH\n${research}\n\n`
        + `TASK\n${refined}`
    )
}

export function autoAnswerPrompt(question, refined, research) {
    return (
        'Answer this question about a development task, using only the research below and the '
        + 'project itself. Read files if you need to.\n\n'
        + 'Answer in exactly one of these two forms:\n\n'
        + 'ANSWER: <the answer, one or two sentences, grounded in something you can point at>\n'
        + 'UNKNOWN: <what a person would have to decide, because the project does not say>\n\n'
        + 'Prefer UNKNOWN over a guess. An answer you invented is worse than a question the user is '
        + 'asked.\n\n'
        + `RESEARCH\n${research}\n\n`
        + `TASK\n${refined}\n\n`
        + `QUESTION\n${question}`
    )
}

export const NO_COMMANDS = '(none)'

export function composePrompt(refined, research, answers) {
    return (
        'Write the implementation specification for one task in a Godot project. Everything you need '
        + 'is below; do not go looking for more.\n\n'
        + 'Answer in exactly these four sections, in this order, with the headings bare on their own '
        + 'lines and nothing before the first one:\n\n'
        + 'GOAL\n'
        + 'One paragraph. What will be true when this is done.\n\n'
        + 'CONSTRAINTS\n'
        + '- One rule per line. Every decision below appears here as a rule.\n'
        + '- One line must read `Do not modify` followed by every document this work is measured '
        + 'against, each in backticks — the design document always, and any specification or audit '
        + 'the task is answering. Gofer refuses writes to them for the whole task. A gap that is '
        + 'easier to document than to close has been documented instead before now, and the file '
        + 'ended up contradicting itself.\n\n'
        + 'STEPS\n'
        + '1. One action per line, in the order they happen, each naming the file it touches.\n\n'
        + 'VERIFY\n'
        + 'A fenced block of shell commands that prove the work. Above each one, a `#` line naming '
        + 'what it proves — that name is what the user watches while it runs:\n'
        + '```sh\n'
        + '# <what this command proves>\n'
        + '<the command>\n'
        + '```\n'
        + 'Commands come from TOOLING, plus one you may add: a check this task writes and runs as '
        + '`godot --headless --audio-driver Dummy --script .gofer/checks/<name>.gd`, which Gofer '
        + 'already keeps out of git. Paths are relative to the workspace; an absolute one is refused. '
        + 'It boots the '
        + 'real scene, drives the feature, prints its result, and exits non-zero when it fails.\n'
        + 'Assert the END of the chain, never the middle. A check that counts what the code just '
        + 'built passes on broken code: a boss that spawned thirteen parts and registered none of '
        + 'them passed every structural check while it sat frozen and unkillable. The check that '
        + 'catches that one asserts a soldier acquires a part.\n'
        + `When there is nothing to run at all, the block holds exactly \`${NO_COMMANDS}\` and `
        + 'nothing else. A command this project does not define is worse than no command: it is a '
        + 'step that always fails.\n\n'
        + 'Use only paths and symbols that appear in the research. Do not invent a file, a method or '
        + 'a command that is not written below. Do not write the implementation itself.\n\n'
        + `RESEARCH\n${research}\n\n`
        + block('DECISIONS — settled, and binding:', answers)
        + `TASK\n${refined}`
    )
}
