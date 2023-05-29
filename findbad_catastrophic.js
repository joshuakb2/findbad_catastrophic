#!/usr/bin/env node

const { Duplex } = require('stream');
const { StringDecoder } = require('string_decoder');
const { Shell } = require('./shell');

/**
 * Make a simple stream from which will store whatever you write to it
 * until you read from it. A identity transform stream.
 */
const makeBufferStream = () => Duplex.from(async function*(chunks) {
    for await (const chunk of chunks) yield chunk;
});

const expect = (stream, prompt) => {
    const found = [];
    let sinceLastMatch = '';
    let streamError;
    const promiseResolvers = [];
    const decoder = new StringDecoder('utf-8');

    const lookForPrompt = () => {
        let index;

        while ((index = sinceLastMatch.indexOf(prompt)) !== -1) {
            const match = sinceLastMatch.substring(0, index);
            const rest = sinceLastMatch.substring(index + prompt.length);
            if (promiseResolvers.length > 0) {
                promiseResolvers.shift().resolve(match);
            }
            else {
                found.push(match);
            }
            sinceLastMatch = rest;
        }
    };

    const onData = chunk => {
        sinceLastMatch += decoder.write(chunk);
        lookForPrompt();
    };
    stream.on('data', onData);

    const onError = err => {
        streamError = err;
        promiseResolvers.forEach(({ reject }) => reject(err));
        promiseResolvers.splice(0, promiseResolvers.length);
    };
    stream.on('error', onError);

    const onEnd = () => {
        streamError = new Error('Stream ended before next prompt was found');
        promiseResolvers.forEach(({ reject }) => reject(streamError));
        promiseResolvers.splice(0, promiseResolvers.length);
    };
    stream.on('end', onEnd);

    return {
        async next() {
            if (found.length > 0) return found.shift();
            if (streamError) throw streamError;
            return await new Promise((resolve, reject) => {
                promiseResolvers.push({ resolve, reject });
            });
        },
        dispose() {
            stream.off('data', onData);
            stream.off('error', onError);
            stream.off('end', onEnd);
            streamError = new Error('Expect disposed');
            promiseResolvers.forEach(({ reject }) => reject(streamError));
            promiseResolvers.splice(0, promiseResolvers.length);
        },
        get found() {
            return found;
        },
    };
};

let promiseForDebugfsExit, debugfsStdin, debugfs;

const openDebugfs = async (device) => {
    const { result, stdin, stdout } = await new Shell().cmd(`debugfs -c ${device} 2>&1`, { shell: true, stdin: 'return', stdout: 'return' });
    promiseForDebugfsExit = result;
    debugfsStdin = stdin;
    debugfs = expect(stdout, 'debugfs:');
    // Discard first prompt
    void debugfs.next().catch(() => {});
};

const sendDebugfsCommand = cmd => debugfsStdin.write(cmd + '\n');

let mostRecentCmdResponseInFull = '';
const debugfsCmd = async cmd => {
    sendDebugfsCommand(cmd);
    const s = mostRecentCmdResponseInFull = await debugfs.next();
    // Skip the first line because it always only contains the prompt and command
    const match = s.match(/(?<=\n)(?:.|\s)*/);
    if (!match) throw new Error(`Got weird response for "${cmd}": ${JSON.stringify(s)}`);
    return match[0];
};

const getStartOfInodeTableByGroup = async () => {
    const result = await debugfsCmd('stats');
    if (!result.includes('Filesystem features')) {
        throw new Error(`Unexpected response from debugfs: ${JSON.stringify(mostRecentCmdResponseInFull)}, also found ${JSON.stringify(debugfs.found)}`);
    }
    const regex = /Group +(\d+): [^\n\r]* inode table at (\d+)/g;
    const map = new Map();
    let match;
    while ((match = regex.exec(result))) map.set(+match[1], 4096 * +match[2]);
    return map;
};

const getAddressOfInode = inode => {
    const group = Math.floor((inode - 1) / 8028);
    const index = (inode - 1) % 8028;
    const startOfInodeTable = startOfInodeTableByGroup.get(group);
    if (startOfInodeTable == null) throw new Error(`Group ${group} was calculated but doesn't exist!!!`);
    return startOfInodeTable + (index * 256);
};

const parseHexRegex = /^([0-7]{4})  (\w\w\w\w) (\w\w\w\w) (\w\w\w\w) (\w\w\w\w) (\w\w\w\w) (\w\w\w\w) (\w\w\w\w) (\w\w\w\w)/gm;

// Get this with the "id" debugfs command
const parseHex = (size, hex) => {
    const buffer = Buffer.alloc(size);
    let match;
    while ((match = parseHexRegex.exec(hex))) {
        const start = parseInt(match[1], 8);
        for (let i = 0; i < 16; i++) {
            buffer[start + i] = parseInt(match[Math.floor(i / 2) + 2].substr((i % 2) * 2, 2), 16);
        }
    }
    return buffer;
};

const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_EXTENTS = 0x080000;

class InodeInfo {
    constructor(id, name, hex) {
        this.id = id;
        this.name = name;
        this.buf = parseHex(256, hex);
    }

    get isDir() {
        return Boolean(this.buf.readUint16LE() & S_IFDIR);
    }

    get isFile() {
        return Boolean(this.buf.readUint16LE() & S_IFREG);
    }

    get usesExtents() {
        return Boolean(this.buf.readUint32LE(0x20) & S_EXTENTS);
    }

    get blocksInUse() {
        const bytes = this.buf.readUint32LE(0x04);
        // Blocks are 4096 bytes
        return Math.ceil(bytes / 4096);
    }

    get_i_block() {
        return this.buf.slice(0x28, 0x28 + 60);
    }

    async dataIsSafe() {
        const i_block = this.get_i_block();
        if (this.usesExtents) return await this.extentsAreSafe(i_block);
        return await this.blocksAreSafe(i_block);
    }

    async extentsAreSafe(buf) {
        const entryCount = buf.readUint16LE(0x02);
        const depth = buf.readUint16LE(0x06);
        const leaf = depth === 0;

        for (let i = 0; i < entryCount; i++) {
            if (leaf) {
                const firstBlockNum = buf.readUint32LE(12 * (i + 1) + 0x08);
                const blockCount = buf.readUint16LE(12 * (i + 1) + 0x04);
                if (!rangeIsSafe(firstBlockNum * 4096, (firstBlockNum + blockCount) * 4096)) return false;
            }
            else {
                const child = buf.readUint32LE(12 * (i + 1) + 0x04);
                const childBlock = parseHex(4096, await debugfsCmd(`bd ${child}`));
                if (!(await this.extentsAreSafe(childBlock))) return false;
            }
        }

        return true;
    }

    async blocksAreSafe(i_block) {
        const blocksInUse = this.blocksInUse;
        const directBlocks = Math.min(12, blocksInUse);

        for (let i = 0; i < directBlocks; i++) {
            const blockNum = i_block.readUint32LE(i * 4);
            if (!blockIsSafe(blockNum)) return false;
        }

        const level1Blocks = Math.min(blockCounts.L1, blocksInUse - directBlocks);

        if (level1Blocks <= 0) return true;
        const safeL1 = await this.blocksL1AreSafe(i_block.readUint32LE(12 * 4), level1Blocks);
        if (!safeL1) return false;

        const level2Blocks = Math.min(blockCounts.L2, blocksInUse - directBlocks - level1Blocks);

        if (level2Blocks <= 0) return true;
        const safeL2 = await this.blocksL2AreSafe(i_block.readUint32LE(13 * 4), level2Blocks);
        if (!safeL2) return false;

        const level3Blocks = Math.min(blockCounts.L3, blocksInUse - directBlocks - level1Blocks - level2Blocks);

        if (level3Blocks <= 0) return true;
        const safeL3 = await this.blocksL3AreSafe(i_block.readUint32LE(14 * 4), level3Blocks);
        return safeL3;
    }

    async blocksL1AreSafe(blockNum, level1Blocks) {
        const buffer = parseHex(4096, await debugfsCmd(`bd ${blockNum}`));

        for (let i = 0; i < level1Blocks; i++) {
            if (!blockIsSafe(buffer.readUint32LE(i * 4))) return false;
        }

        return true;
    }

    async blocksL2AreSafe(blockNum, level2Blocks) {
        const buffer = parseHex(4096, await debugfsCmd(`bd ${blockNum}`));
        const pointers = Math.ceil(level2Blocks / blockIdsPerBlock);

        for (let i = 0; i < pointers; i++) {
            const pointer = buffer.readUint32LE(i * 4);
            if (!blockIsSafe(pointer)) return false;
            const level1Blocks = (Math.min(level2Blocks, (i + 1) * blockIdsPerBlock) % blockIdsPerBlock) || blockIdsPerBlock;
            if (!(await this.blocksL1AreSafe(pointer, level1Blocks))) return false;
        }

        return true;
    }

    async blocksL3AreSafe(blockNum, level3Blocks) {
        const buffer = parseHex(4096, await debugfsCmd(`bd ${blockNum}`));
        const pointers = Math.ceil(level3Blocks / (blockIdsPerBlock ** 2));

        for (let i = 0; i < pointers; i++) {
            const pointer = buffer.readUint32LE(i * 4);
            if (!blockIsSafe(pointer)) return false;
            const level2Blocks = (Math.min(level3Blocks, (i + 1) * (blockIdsPerBlock ** 2)) % (blockIdsPerBlock ** 2)) || (blockIdsPerBlock ** 2);
            if (!(await this.blocksL2AreSafe(pointer, level2Blocks))) return false;
        }

        return true;
    }
}

const blockCounts = {
    L1: 1024,
    L2: 1024 ** 2,
    L3: 1024 ** 3,
};

const badRanges = [
    { start: 0x23bad54000, length: 0x294000 },
    { start: 0x23ef054000, length: 0x294000 },
    { start: 0x23ef654000, length: 0x294000 },
    { start: 0x23feadc000, length: 0x294000 },
    { start: 0x241f9dc000, length: 0x1539973e00 },
    { start: 0x398da03000, length: 0x0a00 },
];

const rangeIsSafe = (start, end) => {
    for (const range of badRanges) {
        // Overlaps this bad range
        if (end > range.start && start < (range.start + range.length)) return false;
    }

    // Not overlapping any bad ranges
    return true;
};

const blockIsSafe = blockNum => {
    const safe = rangeIsSafe(blockNum * 4096, (blockNum + 1) * 4096);
    // console.log(`Block ${blockNum} is ${safe ? 'safe' : 'not safe'}`);
    return safe;
};

const inodeIsSafe = inode => {
    const address = getAddressOfInode(inode);
    return rangeIsSafe(address, address + 256);
};

const dirEntryRegex = /^\/(\d+)\/\d+\/\d+\/\d+\/([^\/]+)/gm;

const getDirEntries = async inode => {
    const listing = await debugfsCmd(`ls -p <${inode}>`);
    const entries = [];
    let match;

    while ((match = dirEntryRegex.exec(listing))) {
        const inode = +match[1];
        const name = match[2];
        if (name === '.' || name === '..') continue;
        entries.push({ inode, name });
    }

    return entries;
};

const blockIdsPerBlock = 4096 / 4;
const ROOT_DIR_INODE = 2;
let startOfInodeTableByGroup;
const inodesVisited = new Set();

const main = async () => {
    const device = process.argv[2];
    if (!device) throw new Error('You must provide the target device as the only argument');
    require('fs').statSync(device);
    console.log(`Reading ${device}`);
    await openDebugfs(device);
    // Now you can start interacting with the filesystem
    startOfInodeTableByGroup = await getStartOfInodeTableByGroup();
    // Now you can call getAddressOfInode
    const rootDirInfo = new InodeInfo(ROOT_DIR_INODE, '', await debugfsCmd(`id <${ROOT_DIR_INODE}>`));
    await recurse('', rootDirInfo);
    debugfs.dispose();
    debugfsStdin.end();
    await promiseForDebugfsExit;
};

const recurse = async (path, inodeInfo) => {
    const dataIsSafe = await inodeInfo.dataIsSafe();
    if (!dataIsSafe) {
        console.log(`BAD ${path ?? '/'}`);
        return;
    }

    const entries = await getDirEntries(inodeInfo.id);

    const safeEntries = entries.filter(entry => {
        const safe = inodeIsSafe(entry.inode);
        if (!safe) console.log(`BAD ${path}/${entry.name}`);
        return safe;
    });

    const safeEntryInfos = await Promise.all(safeEntries.map(async entry =>
        new InodeInfo(entry.inode, entry.name, await debugfsCmd(`id <${entry.inode}>`))
    ));

    for (const entryInfo of safeEntryInfos) {
        if (inodesVisited.has(entryInfo.id)) continue;
        inodesVisited.add(entryInfo.id);

        if (entryInfo.isFile) {
            if (!(await entryInfo.dataIsSafe())) {
                console.log(`BAD ${path}/${entryInfo.name}`);
                continue;
            }
        }

        if (entryInfo.isDir) {
            await recurse(`${path}/${entryInfo.name}`, entryInfo);
            continue;
        }

        // Files that are not regular files or directories don't matter
        continue;
    }
};

main();
