import {invoke} from './desktop'
import type {SkillsResponse} from '../models/skills'

export async function listSkills(): Promise<SkillsResponse> {
    return await invoke('list_skills')
}

export async function importSkill(sourcePath: string): Promise<SkillsResponse> {
    return await invoke('import_skill', {sourcePath})
}

export async function readSkill(name: string): Promise<string> {
    return await invoke('read_skill', {name})
}

export async function writeSkill(name: string, text: string): Promise<SkillsResponse> {
    return await invoke('write_skill', {name, text})
}

export async function deleteSkill(name: string): Promise<SkillsResponse> {
    return await invoke('delete_skill', {name})
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillsResponse> {
    return await invoke('set_skill_enabled', {name, enabled})
}
