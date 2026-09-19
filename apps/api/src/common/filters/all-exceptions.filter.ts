/**
 * 统一异常过滤器
 * ============================================================
 * 为什么必须有这个文件：
 *
 *   领域层抛的是带 userMessage 的 DomainError（"记-（未编号）借贷不平：
 *   借方合计 1000.00，贷方合计 900.00，差额 100.00"）。
 *   如果直接走 Nest 默认处理，前端只会收到 "Internal server error" ——
 *   用户完全不知道该怎么办。
 *
 *   记账系统的错误信息必须做到两件事：
 *     ① 说清哪里错了（带具体数字）
 *     ② 说清该怎么办（下一步动作）
 *
 * 同时把数据库触发器抛出的 BK_E_* 错误翻译成同样的结构，
 * 这样"应用层拦截"和"数据库层拦截"对用户是同一套提示。
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../../domain/accounting/errors';
import { AiProviderError } from '../../infrastructure/ai/ai-provider.interface';

/** 数据库触发器抛出的错误码 → 用户提示 */
const DB_ERROR_MESSAGES: Record<string, { userMessage: string; status: number }> = {
  BK_E_UNBALANCED: {
    userMessage: '凭证借贷不平衡，数据库拒绝保存。请检查分录金额。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_AMOUNT_NOT_POSITIVE: {
    userMessage: '分录金额必须大于 0。借贷方向请用「借/贷」表达，不要用负数金额。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_NO_LINES: {
    userMessage: '凭证没有任何分录行，不允许过账。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_ZERO_VOUCHER: {
    userMessage: '凭证借贷合计为 0，不允许过账。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_NON_LEAF_ACCOUNT: {
    userMessage: '该科目不是末级科目，不允许记账。请选择其下级明细科目。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_ACCOUNT_INACTIVE: {
    userMessage: '该科目已停用，不允许记账。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_PERIOD_LOCKED: {
    userMessage: '该会计期间已结账，不允许写入凭证。如需修改请先执行「反结账」。',
    status: HttpStatus.CONFLICT,
  },
  BK_E_POSTED_IMMUTABLE: {
    userMessage: '该凭证已过账，不允许修改。如需更正请执行「红冲」。',
    status: HttpStatus.CONFLICT,
  },
  BK_E_NOT_NUMBERED: {
    userMessage: '凭证过账时必须已分配凭证号（内部错误，请重试过账）。',
    status: HttpStatus.CONFLICT,
  },
  BK_E_AUDIT_IMMUTABLE: {
    userMessage: '审计日志只允许追加，不允许修改或删除。',
    status: HttpStatus.FORBIDDEN,
  },
  BK_E_MISSING_AUX: {
    userMessage: '缺少必需的辅助核算维度。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_PERIOD_NOT_FOUND: {
    userMessage: '找不到对应的会计期间，请先初始化该年度的会计期间。',
    status: HttpStatus.NOT_FOUND,
  },
  BK_E_PERIOD_DATE_MISMATCH: {
    userMessage: '凭证日期不在所属会计期间内。',
    status: HttpStatus.BAD_REQUEST,
  },
  BK_E_ALREADY_FILED: {
    userMessage: '该期间的申报表已标记为「已申报」，不允许反结账。',
    status: HttpStatus.CONFLICT,
  },
  BK_E_CLOSE_BLOCKED: {
    userMessage: '结账前检查未通过，请先处理列出的问题。',
    status: HttpStatus.CONFLICT,
  },
};

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  /** ★ 面向用户的中文说明，前端优先展示这个 */
  userMessage: string;
  details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.toErrorBody(exception);

    // 服务端错误才打完整堆栈；客户端错误（用户输入问题）只记一行
    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${body.statusCode} ${body.code}: ${body.userMessage}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} → ${body.statusCode} ${body.code}: ${body.userMessage}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown): ErrorBody {
    // ① 领域错误：已经是给人看的措辞，直接用
    if (exception instanceof DomainError) {
      return {
        statusCode: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        userMessage: exception.userMessage,
      };
    }

    // ② Prisma / 数据库错误：尝试翻译 BK_E_* 触发器错误
    const pgCode = (exception as { code?: string })?.code;
    const rawMessage = exception instanceof Error ? exception.message : String(exception);

    const bkMatch = /BK_E_[A-Z_]+/.exec(rawMessage);
    if (bkMatch) {
      const key = bkMatch[0];
      const mapped = DB_ERROR_MESSAGES[key];
      // 触发器消息里冒号后的部分是带具体数字的中文说明，优先保留
      const detail = this.extractPgDetail(rawMessage);
      return {
        statusCode: mapped?.status ?? HttpStatus.BAD_REQUEST,
        code: key,
        message: rawMessage,
        userMessage: detail ?? mapped?.userMessage ?? '数据库校验未通过。',
      };
    }

    // 唯一约束冲突（如幂等键、发票唯一键、凭证号）
    if (pgCode === 'P2002') {
      const target = (exception as { meta?: { target?: string[] } }).meta?.target?.join('、') ?? '唯一字段';

      // 凭证号冲突单独说清楚：这是并发过账导致的，重试即可，
      // 而不是"你重复录入了"——两者对用户意味着完全不同的动作。
      const isVoucherNo =
        target.includes('voucherNo') ||
        rawMessage.includes('journal_voucher_no_unique') ||
        rawMessage.includes('voucherWord');

      return {
        statusCode: HttpStatus.CONFLICT,
        code: isVoucherNo ? 'BK_E_DUPLICATE_VOUCHER_NO' : 'BK_E_DUPLICATE',
        message: rawMessage,
        userMessage: isVoucherNo
          ? `凭证号冲突（${target}）。这通常是两个人同时过账同一期间的凭证造成的 —— ` +
            `请重新查询该期间凭证列表后重试，系统会分配下一个可用号。` +
            `若反复冲突，请先核对期间内凭证号是否连续。`
          : `记录已存在（唯一字段：${target}）。系统已阻止重复写入。`,
      };
    }

    if (pgCode === 'P2025' || pgCode === 'P2001') {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: 'BK_E_NOT_FOUND',
        message: rawMessage,
        userMessage: '找不到要操作的数据，可能已被删除。',
      };
    }

    if (pgCode === 'P1001' || pgCode === 'P1002') {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'BK_E_DB_UNREACHABLE',
        message: rawMessage,
        userMessage: '数据库暂时不可用，请稍后重试。若持续出现请联系管理员。',
      };
    }

    // ②b 上游 AI 服务出错 —— 这不是"系统内部错误"
    //
    // ★ 为什么单独映射，而不是让它落到 500 兜底：
    //   模型服务超时、限流、返回格式异常，都是**上游**问题。
    //   报 500 会让用户以为本系统坏了、以为是自己的操作有问题，
    //   而实际要做的是"稍后重试"或"先手工录入"。
    //   502 的语义正好是"上游服务出了问题"，与事实相符。
    //
    // ★ 用户可见文案必须给出出路：AI 挂了不该阻塞记账，
    //   因为整个系统的设计前提就是「所有自动化产出都进待确认区」。
    if (exception instanceof AiProviderError) {
      const retryHint = exception.retryable
        ? '这通常是临时的（限流、超时或上游抖动），稍后重试即可。'
        : '重试通常无效 —— 多半是配置或额度问题，需要检查 API Key、模型名与账户余额。';
      return {
        statusCode: exception.httpStatus ?? HttpStatus.BAD_GATEWAY,
        code: 'BK_E_AI_PROVIDER',
        message: `[${exception.provider}] ${exception.message}`,
        userMessage:
          `AI 识别服务暂时不可用：${exception.message}` +
          retryHint +
          '在此期间可以改用「手工录入」—— 记账功能不受影响，' +
          'AI 只是省人工，不是记账的前提。',
      };
    }

    // ③ Nest HTTP 异常（含 ValidationPipe）
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ?? exception.message);
      return {
        statusCode: status,
        code: 'BK_E_HTTP',
        message: Array.isArray(message) ? message.join('；') : message,
        userMessage: Array.isArray(message) ? message.join('；') : message,
        details: typeof res === 'object' ? res : undefined,
      };
    }

    // ④ 兜底：真正的未知错误
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'BK_E_INTERNAL',
      message: rawMessage,
      userMessage:
        '系统内部错误，操作未完成。数据未被修改，请重试；若反复出现请把本次操作和报错内容反馈给管理员。',
    };
  }

  /**
   * 从数据库异常信息里取出冒号后的人类可读说明。
   * 触发器里的 RAISE EXCEPTION 'BK_E_XXX: 中文说明' 会被包装多层，
   * 这里尽量还原出那句中文。
   */
  private extractPgDetail(raw: string): string | null {
    const m = /BK_E_[A-Z_]+:\s*([^\n]+)/.exec(raw);
    if (!m?.[1]) return null;
    const detail = m[1].trim();
    // 过滤掉纯英文的 SQL 上下文
    return /[\u4e00-\u9fff]/.test(detail) ? detail : null;
  }
}
