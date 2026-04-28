const fs = require('fs');

let content = fs.readFileSync('src/lib/build-categories.ts', 'utf8');

const colorMap = {
    'emerald-600': '#059669', 'teal-700': '#0f766e', 'orange-500': '#f97316', 'red-600': '#dc2626',
    'amber-400': '#fbbf24', 'rose-500': '#f43f5e', 'slate-600': '#475569', 'slate-700': '#334155',
    'slate-900': '#0f172a', 'fuchsia-500': '#d946ef', 'pink-600': '#db2777', 'stone-300': '#d6d3d1',
    'stone-700': '#44403c', 'yellow-400': '#facc15', 'stone-500': '#78716c', 'emerald-700': '#047857',
    'indigo-500': '#6366f1', 'violet-700': '#6d28d9', 'blue-500': '#3b82f6', 'violet-500': '#8b5cf6',
    'pink-500': '#ec4899', 'zinc-100': '#f4f4f5', 'zinc-500': '#71717a', 'zinc-700': '#3f3f46',
    'zinc-900': '#18181b', 'amber-200': '#fde68a', 'stone-600': '#57534e', 'white': '#ffffff',
    'zinc-300': '#d4d4d8', 'black': '#000000', 'lime-400': '#a3e635', 'blue-600': '#2563eb',
    'indigo-700': '#4338ca', 'rose-200': '#fecdd3', 'orange-400': '#fb923c', 'yellow-300': '#fde047',
    'teal-300': '#5eead4', 'sky-500': '#0ea5e9', 'blue-700': '#1d4ed8', 'pink-400': '#f472b6',
    'purple-500': '#a855f7', 'zinc-700': '#3f3f46'
};

const regex = /swatch:\s*"([^"]+)"/g;

content = content.replace(regex, (match, swatch) => {
    if (match.includes('colors:')) return match;
    
    let colors = [];
    let parts = swatch.match(/from-([a-z0-9-]+)(?:\s+via-([a-z0-9-]+))?\s+to-([a-z0-9-]+)/);
    
    if (parts) {
        let c1 = colorMap[parts[1]] || '#000000';
        let c2 = parts[2] ? (colorMap[parts[2]] || '#888888') : null;
        let c3 = colorMap[parts[3]] || '#ffffff';
        
        if (c2) colors = `["${c1}", "${c2}", "${c3}"]`;
        else colors = `["${c1}", "${c3}", "#ffffff"]`;
        
        return `${match},\n        colors: ${colors}`;
    }
    return match;
});

fs.writeFileSync('src/lib/build-categories.ts', content);
console.log("Done");
