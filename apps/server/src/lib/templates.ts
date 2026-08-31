import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = process.env.REPO_ROOT || path.resolve(__dirname, '../../../..');

export function getRepoRoot() {
  return repoRoot;
}

export function renderCatAgentPrompt(params: {
  catName: string;
  personality: string;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  ownerNickname: string;
}): string {
  const templatePath = path.join(repoRoot, 'templates/cat-agent-config.md');
  let template = fs.readFileSync(templatePath, 'utf8');
  const bodyStart = template.indexOf('---\n\n');
  if (bodyStart >= 0) template = template.slice(bodyStart + 5);

  return template
    .replace(/\{\{cat_name\}\}/g, params.catName)
    .replace(/\{\{personality\}\}/g, params.personality)
    .replace(/\{\{attr_courage\}\}/g, String(params.attrs.courage))
    .replace(/\{\{attr_curiosity\}\}/g, String(params.attrs.curiosity))
    .replace(/\{\{attr_affinity\}\}/g, String(params.attrs.affinity))
    .replace(/\{\{attr_insight\}\}/g, String(params.attrs.insight))
    .replace(/\{\{owner_nickname\}\}/g, params.ownerNickname);
}

export function renderDailyTravelTask(catName: string, serverUrl: string): string {
  const yamlPath = path.join(repoRoot, 'tasks/cat/daily-travel.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const lines: string[] = [];
  let section = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('objective:')) section = 'objective';
    else if (line.startsWith('context:')) section = 'context';
    else if (line.startsWith('steps:')) section = 'steps';
    else if (line.startsWith('constraints:')) section = 'constraints';
    else if (line.startsWith('success_criteria:')) section = 'success';
    else if (line.startsWith('outputs:') || line.startsWith('on_failure:')) section = '';

    if (!section || line.match(/^(id:|name:|version:|owner_role:|schedule:|enabled:|#)/)) continue;
    const cleaned = line
      .replace(/\{\{cat_name\}\}/g, catName)
      .replace(/\{\{server_url\}\}/g, serverUrl)
      .replace(/^  - /, '- ')
      .replace(/^  /, '');
    if (cleaned.trim()) lines.push(cleaned);
  }
  return `# 小猫每日探险任务\n\n${lines.join('\n')}`;
}
