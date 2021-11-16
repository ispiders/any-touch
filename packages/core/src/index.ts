/**
 * 主程序, 不包含手势,
 * 主要用来适配Mouse/Touch事件
 * ==================== 参考 ====================
 * https://segmentfault.com/a/1190000010511484#articleHeader0
 * https://segmentfault.com/a/1190000007448808#articleHeader1
 * hammer.js http://hammerjs.github.io/
 * ==================== 流程 ====================
 * Event(Mouse|Touch) => BaseInput => Input => Computed => AnyTouchEvent
 */
import AnyEvent from 'any-event';
import type {
    Computed,
    AnyTouchEvent,
    SupportEvent,
    InputCreatorFunctionMap,
    InputCreatorFunction,
    ComputeFunction,
    ComputeFunctionCreator,
    KV, PluginContext, Plugin,
} from '@any-touch/shared';

import {
    TOUCH_START,
    TOUCH_MOVE,
    TOUCH_END,
    TOUCH_CANCEL,
    MOUSE_DOWN,
    MOUSE_MOVE,
    MOUSE_UP,
} from '@any-touch/shared';

import { mouse, touch } from './createInput';
import dispatchDomEvent from './dispatchDomEvent';
import canPreventDefault from './canPreventDefault';
import bindElement from './bindElement';
// type TouchAction = 'auto' | 'none' | 'pan-x' | 'pan-left' | 'pan-right' | 'pan-y' | 'pan-up' | 'pan-down' | 'pinch-zoom' | 'manipulation';

/**
 * 默认设置
 */
export interface Options {
    // 是否触发DOM事件
    domEvents?: false | EventInit;
    preventDefault?: boolean;
    // 不阻止默认行为的白名单
    preventDefaultExclude?: RegExp | ((ev: SupportEvent) => boolean);
}

/**
 * 默认设置
 */
const DEFAULT_OPTIONS: Options = {
    domEvents: { bubbles: true, cancelable: true },
    preventDefault: true,
    preventDefaultExclude: /^(?:INPUT|TEXTAREA|BUTTON|SELECT)$/,
};

const TYPE_UNBIND = 'u';

export default class Core extends AnyEvent<KV & { computed: AnyTouchEvent }> {
    // 目标元素
    el?: HTMLElement;

    // 选项
    private __options: Options;
    // 事件类型和输入函数的映射
    private __inputCreatorMap: InputCreatorFunctionMap;


    // 计算函数队列
    private __computeFunctionList: ComputeFunction[] = [];
    // 计算函数生成器仓库
    private __computeFunctionCreatorList: ComputeFunctionCreator[] = [];

    // 插件
    private __plugins: PluginContext[] = [];

    /**
     * @param el 目标元素, 微信下没有el
     * @param options 选项
     */
    constructor(el?: HTMLElement, options?: Options) {
        super();

        this.el = el;
        this.__options = { ...DEFAULT_OPTIONS, ...options };

        // 之所以强制是InputCreatorFunction<SupportEvent>,
        // 是因为调用this.__inputCreatorMap[event.type]的时候还要判断类型,
        // 因为都是固定(touch&mouse)事件绑定好的, 没必要判断
        const createInputFromTouch = touch(this.el) as InputCreatorFunction<SupportEvent>;
        const createInputFromMouse = mouse() as InputCreatorFunction<SupportEvent>;
        this.__inputCreatorMap = {
            [TOUCH_START]: createInputFromTouch,
            [TOUCH_MOVE]: createInputFromTouch,
            [TOUCH_END]: createInputFromTouch,
            [TOUCH_CANCEL]: createInputFromTouch,
            [MOUSE_DOWN]: createInputFromMouse,
            [MOUSE_MOVE]: createInputFromMouse,
            [MOUSE_UP]: createInputFromMouse,
        };

        // 绑定事件
        if (void 0 !== el) {
            // 观察了几个移动端组件, 作者都会加webkitTapHighlightColor
            // 比如vant ui
            // 所以在此作为默认值
            // 使用者也可通过at.el改回去
            el.style.webkitTapHighlightColor = 'rgba(0,0,0,0)';
            // 校验是否支持passive
            let supportsPassive = false;
            try {
                const opts = {};
                Object.defineProperty(opts, 'passive', {
                    get() {
                        // 不想为测试暴露, 会增加体积, 暂时忽略
                        /* istanbul ignore next */
                        supportsPassive = true;
                    },
                });
                window.addEventListener('_', () => void 0, opts);
            } catch { }

            // 绑定元素
            this.on(
                TYPE_UNBIND,
                bindElement(
                    el,
                    this.catchEvent.bind(this),
                    !this.__options.preventDefault && supportsPassive ? { passive: true } : false
                )
            );
        }
    }

    target(el: HTMLElement) {
        // return {
        //     on: (eventName: string, listener: Listener<AnyTouchEvent>): void => {
        //         this.on(eventName, listener, (event) => {
        //             const { targets } = event;
        //             // 检查当前触发事件的元素是否是其子元素
        //             return targets.every((target) => el.contains(target as HTMLElement));
        //         });
        //     },
        // };
    }

    /**
     * 带DOM事件的emit
     */
    emit2(type: string, payload: AnyTouchEvent) {
        this.emit(type, payload);
        // this.emit('at:after',{...payload,name:type})
        const { target } = payload;
        const { domEvents } = this.__options;
        // 触发DOM事件
        if (!!domEvents && void 0 !== this.el && null !== target) {
            // 所以此处的target会自动冒泡到目标元素
            dispatchDomEvent(target, { ...payload, type }, domEvents);
            // dispatchDomEvent(target, { ...payload, type:'at:after',name:type }, domEvents);
        }
    }

    /**
     * 监听input变化
     * @param event Touch / Mouse事件对象
     */
    catchEvent(event: SupportEvent) {
        console.log(event.type);
        const stopPropagation = () => event.stopPropagation();
        const preventDefault = () => event.preventDefault();
        const stopImmediatePropagation = () => event.stopImmediatePropagation();
        if (canPreventDefault(event, this.__options)) {
            preventDefault();
        }
        // if (!event.cancelable) {
        //     this.emit('error', { code: 0, message: '页面滚动的时候, 请暂时不要操作元素!' });
        // }
        const input = this.__inputCreatorMap[event.type](event);

        // 跳过无效输入
        // 比如没有按住鼠标左键的移动会返回undefined
        if (void 0 !== input) {
            this.emit('input', input);
            this.emit2(`at:${input.phase}`, input as AnyTouchEvent);

            // ====== 计算结果 ======
            const computed: Computed = {};
            this.__computeFunctionList.forEach((compute) => {
                // disabled
                const result = compute(input, computed);
                if (void 0 !== result) {
                    for (const key in result) {
                        computed[key] = result[key];
                    }
                }
            });

            this.emit('computed', { ...input, ...computed, stopPropagation, preventDefault, stopImmediatePropagation });
        }
    }

    /**
     * 缓存计算函数生成器到队列
     * @param computeFunctionCreatorList 一组计算函数生成器
     */
    compute(computeFunctionCreatorList: ComputeFunctionCreator[]) {
        for (const computeFunctionCreator of computeFunctionCreatorList) {
            if (!this.__computeFunctionCreatorList.includes(computeFunctionCreator)) {
                // 计算函数生成器队列
                this.__computeFunctionCreatorList.push(computeFunctionCreator);
                // 计算函数队列
                this.__computeFunctionList.push(computeFunctionCreator());
            }
        }
    }

    /**
     * 加载并初始化插件
     * @param plugin 插件
     * @param pluginOptions 插件选项
     */
    use(plugin: Plugin, pluginOptions?: any) {
        this.__plugins.push(plugin(this, pluginOptions));
    }

    /**
     * 获取识别器通过名字
     * @param name 识别器的名字
     * @return 返回识别器
     */
    get(name: string) {
        for (const plugin of this.__plugins) {
            if (name === plugin.name) {
                return plugin;
            }
        }
    }

    /**
     * 设置
     * @param options 选项
     */
    set(options: Options) {
        this.__options = { ...this.__options, ...options };
    }

    /**
     * 销毁
     */
    destroy() {
        // 解绑事件
        this.emit(TYPE_UNBIND);
        super.destroy();
    }
}