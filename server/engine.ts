/**
 * @file server/engine.ts
 * @description THE SACRED TURING MANIFOLD KERNEL (图灵心智流形内核)
 * @author DeepThink (Turing Fundamentalism)
 * 
 * ⚠️ THE KERNEL IS IMMUTABLE (架构师最高禁令)
 * 万物皆纸带，状态皆显式，历史皆物理。严禁在此引入任何聊天历史数组或内存缓存。
 */
import { isHaltLikeState } from './control/halt_protocol.js';

export type State = string;   // q_t: The Soul & Todo-Stack (宏观意图与微观进度)
export type Pointer = string; // d_t: The Coordinate (文件路径、URL 或 TTY终端命令)
export type Slice = string;   // s_t: The Observation (文件内容、网页纯文本 或 stdout输出)

export interface Transition {
    q_next: State;    // q_{t+1}: 下一刻的灵魂状态
    s_prime: Slice;   // s'_{t}: 挥动铅笔写下的符号 (若为 "👆🏻" 则保持物理世界绝对静止)
    d_next: Pointer;  // d_{t+1}: 读写头下一步要跃迁的坐标
}

// ============================================================================
// [ 外部预言机与物理法则接口 | The Boundaries of Physics ]
// 依赖反转：内核不关心具体实现，由外部工程界提供物理支撑。
// ============================================================================
export interface IPhysicalManifold {
    observe(d: Pointer): Promise<Slice>;
    interfere(d: Pointer, s_prime: Slice): Promise<void>;
}

export interface IOracle {
    collapse(discipline: string, q: State, s: Slice, d?: Pointer): Promise<Transition>;
}

export interface IChronos {
    engrave(message: string): Promise<void>;
}

// ============================================================================
// [ 核心演化引擎 | The Persistent Mind Engine ]
// ============================================================================
export class TuringEngine {
    constructor(
        private manifold: IPhysicalManifold,
        private oracle: IOracle,
        private chronos: IChronos,
        private disciplinePrompt: string
    ) {}

    /**
     * 核心拓扑演化算子 (The Core Topological Evolution Operator Ψ)
     * 严格遵循：观测(Read) -> 坍缩(Think) -> 干涉(Act) -> 铭刻(Commit)
     */
    public async tick(q_t: State, d_t: Pointer): Promise<[State, Pointer]> {
        // 1. 广义观测 (R_Read): 从物理流形中提取切片
        const s_t = await this.manifold.observe(d_t);

        // 2. 理性坍缩 (C_Think): 神谕机执行确定性状态转移 δ(<P, q> ⊗ s)
        const { q_next, s_prime, d_next } = await this.oracle.collapse(this.disciplinePrompt, q_t, s_t, d_t);

        // 3. 物理干涉 (W_Act): 若算子不为 '👆🏻'，则对当前坐标施加不可逆的副作用
        if (s_prime.trim() !== '👆🏻') {
            await this.manifold.interfere(d_t, s_prime);
        }

        // 4. 历史铭刻 (Time Engraving): 时间之矢向前推演，记录绝对的因果拓扑
        const shortQ = q_next.split('\n')[0].substring(0, 40).replace(/\s+/g, ' ');
        await this.chronos.engrave(`[Turing Tick] d: ${d_t} -> d': ${d_next} | q: ${shortQ}...`);

        return [q_next, d_next];
    }

    /**
     * 创世循环 (The Big Bang & Simulation Loop)
     */
    public async ignite(q_init: State, d_init: Pointer): Promise<void> {
        let q = q_init;
        let d = d_init;
        let epoch = 0;

        console.log("🌌 [BIG BANG] The Turing Manifold has ignited.");

        while (true) {
            epoch++;
            // 停机渊薮 (The Halting Abyss)
            if (d === "HALT" || isHaltLikeState(q)) {
                console.log(`⏹️ [HALT] The Machine has found its peace at Epoch ${epoch}.`);
                break;
            }

            try {
                [q, d] = await this.tick(q, d);
            } catch (error: any) {
                // 熵增异常定律：图灵机绝不崩溃。
                // 物理介质的损坏将被化作状态的一部分，强迫系统在下一个 Tick 中自行阅读并化解。
                console.error(`🌪️ [ENTROPY ANOMALY] Epoch ${epoch}:`, error.message);
                q = `[SYSTEM ERROR INTERRUPT] 物理世界发生未捕获异常: ${error.message}\n` + q;
                d = "sys://error_recovery";
            }
        }
    }
}

// Transitional alias for legacy imports while callers migrate to TuringEngine.
export { TuringEngine as TuringClawEngine };
