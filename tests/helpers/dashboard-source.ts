import {readFileSync} from 'node:fs';
const read=(name:string)=>readFileSync(new URL('../../src/public/'+name,import.meta.url),'utf8');

/** The page's own script, as the browser loads it from /brand/dashboard.js. */
export const dashboardScript=read('brand/dashboard.js');
export const dashboardStyles=read('brand/dashboard.css');
export const dashboardPage=read('dashboard.html');
/** Page, stylesheet and script together — what the browser ends up with. Tests that search for
 * markup or text use this; a test that PARSES JavaScript must use dashboardScript, because the
 * script is no longer wrapped in a <script> tag and a tag-based search would silently match
 * nothing. */
export const dashboardSource=[dashboardPage,dashboardStyles,read('brand/agent-chat.js'),dashboardScript].join('\n');
