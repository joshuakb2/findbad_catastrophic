"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Shell = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_string_decoder_1 = require("node:string_decoder");
/**
 * Represents a shell or a subshell, like in bash.
 * Holds a current directory, environment variables (exported), and standard streams.
 */
class Shell {
    #workdir;
    #env;
    #stdio;
    #verbose;
    constructor(config = {}) {
        let { stdin, stdout, stderr } = config.stdio ?? {};
        this.setWorkDir((0, node_path_1.resolve)(config.workdir ?? process.cwd()));
        this.#env = copyEnvAndRemoveUndefined(config.env ?? process.env);
        this.#stdio = {
            stdin: shellStreamFromOptions(stdin, 'stdin'),
            stdout: shellStreamFromOptions(stdout, 'stdout'),
            stderr: shellStreamFromOptions(stderr, 'stderr'),
        };
        this.#verbose = config.verbose ?? false;
        if (this.#verbose) {
            this.log('this.#stdio = ' + JSON.stringify({
                stdin: this.#stdio.stdin ? 'readable' : 'ignored',
                stdout: this.#stdio.stdout ? 'writable' : 'ignored',
                stderr: this.#stdio.stderr ? 'writable' : 'ignored',
            }));
        }
    }
    /**
     * Change the working directory of this shell instance.
     */
    cd(relative) {
        if (this.#verbose)
            this.log(`cd ${relative}`);
        this.setWorkDir((0, node_path_1.resolve)(this.#workdir, relative));
    }
    /**
     * Set an environment variable.
     */
    setEnv(name, value) {
        if (this.#verbose)
            this.log(`${name}=${value}`);
        this.#env[name] = value;
    }
    /**
     * Delete an environment variable.
     */
    deleteEnv(name) {
        if (this.#verbose)
            this.log(`unset ${name}`);
        delete this.#env[name];
    }
    /**
     * Change the stdin handling.
     */
    setStdin(stdin) {
        if (this.#verbose)
            this.log(`stdin = ${hasFd(stdin) ? `fd ${stdin.fd}` : stdin instanceof Object ? 'readable stream' : stdin}`);
        this.#stdio.stdin = shellStreamFromOptions(stdin, 'stdin');
    }
    /**
     * Change the stdout handling.
     */
    setStdout(stdout) {
        if (this.#verbose)
            this.log(`stdout = ${hasFd(stdout) ? `fd ${stdout.fd}` : stdout instanceof Object ? 'writable stream' : stdout}`);
        if (stdout === 'stderr') {
            this.#stdio.stdout = this.#stdio.stderr;
        }
        else {
            this.#stdio.stdout = shellStreamFromOptions(stdout, 'stdout');
        }
    }
    /**
     * Change the stderr handling.
     */
    setStderr(stderr) {
        if (this.#verbose)
            this.log(`stderr = ${hasFd(stderr) ? `fd ${stderr.fd}` : stderr instanceof Object ? 'writable stream' : stderr}`);
        if (stderr === 'stdout') {
            this.#stdio.stderr = this.#stdio.stdout;
        }
        else {
            this.#stdio.stderr = shellStreamFromOptions(stderr, 'stderr');
        }
    }
    get stdin() { return this.#stdio.stdin; }
    get stdout() { return this.#stdio.stdout; }
    get stderr() { return this.#stdio.stderr; }
    /**
     * Get a new shell that inherits settings from this shell.
     */
    subshell() {
        return new Shell({
            workdir: this.#workdir,
            env: this.#env,
            stdio: this.#stdio,
            verbose: this.#verbose,
        });
    }
    /**
     * Use a subshell for an async job.
     */
    async withSubshell(f) {
        return await f(this.subshell());
    }
    cmd(...args) {
        let trace = new Error().stack.split('\n').slice(6).join('\n');
        let cmd;
        let cmdArgs;
        let options;
        if (typeof args[args.length - 1] === 'object') {
            cmd = args[0];
            cmdArgs = args.slice(1, args.length - 1);
            options = args[args.length - 1];
        }
        else {
            cmd = args[0];
            cmdArgs = args.slice(1);
            options = {};
        }
        if (this.#verbose)
            this.log(`Executing ${cmd} ${cmdArgs.join(' ')} # ${JSON.stringify({
                ...options,
                stdin: options.stdin instanceof Object ? 'readable' : options.stdin,
                stdout: options.stdout instanceof Object ? 'writable' : options.stdout,
                stderr: options.stderr instanceof Object ? 'writable' : options.stderr,
            })}`);
        let [stdinOpt, stdinPipeSrc] = this.getStdioSpawnOption(options, 'stdin');
        let [stdoutOpt, stdoutPipeDest] = this.getStdioSpawnOption(options, 'stdout');
        let [stderrOpt, stderrPipeDest] = this.getStdioSpawnOption(options, 'stderr');
        let spawnOptions = {
            shell: options.shell ? 'sh' : undefined,
            env: (options.inheritEnv ?? true) ?
                options.env ?
                    { ...this.#env, ...options.env } :
                    this.#env :
                options.env ?? {},
            stdio: [stdinOpt, stdoutOpt, stderrOpt],
            cwd: this.#workdir,
            // Makes this process a new process group leader, allowing us to kill it and all of its children with one command.
            detached: Boolean(options.abortSignal),
        };
        let p = options.shell ?
            (0, node_child_process_1.spawn)([cmd, ...cmdArgs].join(' '), spawnOptions) :
            (0, node_child_process_1.spawn)(cmd, cmdArgs, spawnOptions);
        let result = new Promise((resolve, reject) => {
            let exitCode;
            let stdout;
            let stderr;
            p.on('close', (code, signal) => { exitCode = signal ?? code; finish(); });
            p.on('error', reject);
            if (stdinPipeSrc) {
                stdinPipeSrc.pipe(p.stdin);
            }
            if (typeof options.stdout === 'string' && options.stdout.startsWith('capture')) {
                stdout = '';
                let decoder = new node_string_decoder_1.StringDecoder('utf-8');
                p.stdout?.on('data', (chunk) => stdout += decoder.write(chunk));
                if (options.trimNewlines ?? true) {
                    p.stdout?.on('end', () => {
                        if (stdout[stdout.length - 1] === '\n') {
                            stdout = stdout.slice(0, stdout.length - 1);
                        }
                    });
                }
            }
            else if (stdoutPipeDest) {
                p.stdout?.pipe(stdoutPipeDest, { end: false });
            }
            if (typeof options.stderr === 'string' && options.stderr.startsWith('capture')) {
                stderr = '';
                let decoder = new node_string_decoder_1.StringDecoder('utf-8');
                p.stderr?.on('data', (chunk) => stderr += decoder.write(chunk));
                if (options.trimNewlines ?? true) {
                    p.stderr?.on('end', () => {
                        if (stderr[stderr.length - 1] === '\n') {
                            stderr = stderr.slice(0, stderr.length - 1);
                        }
                    });
                }
            }
            else if (stderrPipeDest) {
                p.stderr?.pipe(stderrPipeDest, { end: false });
            }
            const onAbort = () => {
                this.cmd(`kill -9 -- -${p.pid}`, { shell: true }).catch(err => {
                    console.error(`Shell: Error when spawning kill command: ${err.message}`);
                });
            };
            options.abortSignal?.addEventListener('abort', onAbort);
            function finish() {
                options.abortSignal?.removeEventListener('abort', onAbort);
                if (options.abortSignal?.aborted) {
                    reject(new Error('Aborted'));
                    return;
                }
                if (options.returnExitCode || exitCode === 0) {
                    resolve({
                        exitCode: options.returnExitCode ? exitCode : null,
                        stdout: typeof options.stdout === 'string' && options.stdout.startsWith('capture') ? (options.stdout === 'capture lines' ? stdout.split(/\r\n|\n|\r/) :
                            options.stdout === 'capture words' ? stdout.split(/\s+/).filter(s => s) :
                                stdout) : null,
                        stderr: typeof options.stderr === 'string' && options.stderr.startsWith('capture') ? (options.stdout === 'capture lines' ? stderr.split(/\r\n|\n|\r/) :
                            options.stderr === 'capture words' ? stderr.split(/\s+/).filter(s => s) :
                                stderr) : null,
                    });
                }
                else {
                    let errorMsg = `"${[cmd, ...cmdArgs].join(' ')}" failed: ${typeof exitCode === 'number' ? `code ${exitCode}` : exitCode}`;
                    let error = new Error(errorMsg);
                    error.stack = 'Error: ' + errorMsg + '\n' + trace;
                    reject(error);
                }
            }
        });
        if (options.stdin === 'return' || options.stdout === 'return' || options.stderr === 'return') {
            let r = {
                result,
                stdin: options.stdin === 'return' ? p.stdin : null,
                stdout: options.stdout === 'return' ? p.stdout : null,
                stderr: options.stderr === 'return' ? p.stderr : null,
            };
            return r;
        }
        else {
            return result;
        }
    }
    async pipe(cmds, defaultOptions) {
        let previousStdout;
        let promises = cmds.map((cmd, i) => {
            let addOptions;
            let options;
            if (typeof cmd[cmd.length - 1] === 'string') {
                addOptions = true;
                options = defaultOptions ?? {};
            }
            else {
                addOptions = false;
                options = cmd[cmd.length - 1];
                if (defaultOptions) {
                    for (let key in defaultOptions) {
                        if (!(key in options)) {
                            options[key] = defaultOptions[key];
                        }
                    }
                }
            }
            let fullCmd = addOptions ? [...cmd, options] : cmd;
            if (i < cmds.length - 1) {
                options.stdout = 'return';
            }
            if (i > 0) {
                options.stdin = previousStdout;
            }
            let output = this.cmd(...fullCmd);
            if (output instanceof Promise) {
                previousStdout = undefined;
                return output;
            }
            else {
                previousStdout = output.stdout;
                return output.result;
            }
        });
        return await Promise.all(promises);
    }
    async test(...args) {
        let options;
        let testArgs;
        if (typeof args[args.length - 1] === 'object') {
            options = args[args.length - 1];
            testArgs = args.slice(0, args.length - 1);
        }
        else {
            options = null;
            testArgs = args;
        }
        let { exitCode } = await this.cmd('test', ...testArgs, { ...options, returnExitCode: true });
        return exitCode === 0;
    }
    /**
     * Send a log message to the configured stdout stream (newline added automatically).
     */
    log(msg) {
        this.#stdio.stdout?.write(`[${this.#workdir}] ${msg}\n`);
    }
    // Never actually use 'inherit', even if the user specifies 'inherit'.
    // The user specifying 'inherit' should mean that this command inherits the
    // streams of the shell, not of the node process.
    //
    // If a stream with a file descriptor is given, use the file descriptor instead
    // of piping everything through this node process. Should be more efficient.
    getStdioSpawnOption(options, stream) {
        const value = options[stream] ?? 'inherit';
        if (typeof value === 'object') {
            return hasFd(value) ? [value.fd, null] : ['pipe', value];
        }
        if (value === 'inherit') {
            const shellStream = this.#stdio[stream];
            return hasFd(shellStream) ? [shellStream.fd, null] : ['pipe', shellStream];
        }
        if (value === 'stdout' || value === 'stderr') {
            const shellStream = this.#stdio[value];
            return hasFd(shellStream) ? [shellStream.fd, null] : ['pipe', shellStream];
        }
        if (value.startsWith('capture') || value === 'return')
            return ['pipe', null];
        return ['ignore', null];
    }
    setWorkDir(workdir) {
        const stat = (0, node_fs_1.statSync)(workdir);
        if (!stat.isDirectory)
            throw new Error(`cd into "${workdir}" which is not a directory`);
        this.#workdir = workdir;
    }
}
exports.Shell = Shell;
function copyEnvAndRemoveUndefined(o) {
    let copy = {};
    for (let key in o) {
        let value = o[key];
        if (value == null)
            continue;
        copy[key] = value;
    }
    return copy;
}
// Reassure typescript that the value passed in is an object with a numeric "fd" property
function hasFd(x) {
    return typeof x === 'object' && x != null && typeof x.fd === 'number';
}
function shellStreamFromOptions(value, stream) {
    return (value === 'inherit' ? process[stream] :
        value === 'ignore' ? null :
            value);
}
