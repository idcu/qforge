/**
 * 内置样例题库（少量，用于空系统演示与自测；不含用户抓取的 541 题）
 * 结构：标准题目模型数组（不含 id/bankId，由导入流程补齐）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.SAMPLE = {
    name: '示例题库',
    description: '系统内置样例，覆盖判断/单选/多选/不定项/填空/简答六种题型',
    questions: [
      // 判断题
      { type: 'judge', question: '串联电路中，各处的电流相等。', options: [], answer: '正确', analysis: '串联电路电流处处相等。' },
      { type: 'judge', question: '水的沸点在标准大气压下是 100℃。', options: [], answer: '正确', analysis: '标准大气压(101.325kPa)下纯水沸点为 100℃。' },
      { type: 'judge', question: '防火墙只能防止外部网络攻击，无法限制内部访问。', options: [], answer: '错误', analysis: '防火墙同样可用于限制内部网络之间的访问。' },

      // 单选题
      {
        type: 'single', question: '下列哪种不是数据清洗的常见步骤？',
        options: [
          { letter: 'A', text: '缺失值处理' },
          { letter: 'B', text: '异常值检测' },
          { letter: 'C', text: '模型训练' },
          { letter: 'D', text: '重复数据删除' }
        ],
        answer: 'C', analysis: '模型训练属于建模阶段，不属于数据清洗。'
      },
      {
        type: 'single', question: 'SQL 中用于查询数据的关键字是？',
        options: [
          { letter: 'A', text: 'SELECT' }, { letter: 'B', text: 'UPDATE' },
          { letter: 'C', text: 'DELETE' }, { letter: 'D', text: 'INSERT' }
        ],
        answer: 'A', analysis: 'SELECT 用于查询数据。'
      },
      {
        type: 'single', question: 'Python 中定义函数的关键字是？',
        options: [
          { letter: 'A', text: 'func' }, { letter: 'B', text: 'def' },
          { letter: 'C', text: 'function' }, { letter: 'D', text: 'lambda' }
        ],
        answer: 'B', analysis: 'def 是定义函数的关键字。'
      },

      // 多选题
      {
        type: 'multi', question: '以下哪些属于数据质量维度？',
        options: [
          { letter: 'A', text: '完整性' }, { letter: 'B', text: '准确性' },
          { letter: 'C', text: '一致性' }, { letter: 'D', text: '及时性' }
        ],
        answer: 'ABCD', analysis: '完整性、准确性、一致性、及时性均为常见数据质量维度。'
      },
      {
        type: 'multi', question: '下列哪些措施有助于防止过拟合？',
        options: [
          { letter: 'A', text: '增加训练数据' }, { letter: 'B', text: '使用正则化' },
          { letter: 'C', text: '增大模型复杂度' }, { letter: 'D', text: '早停法' }
        ],
        answer: 'ABD', analysis: '增大模型复杂度会加剧过拟合，其余三项有效。'
      },
      {
        type: 'multi', question: '数据库事务的 ACID 特性包括哪些？',
        options: [
          { letter: 'A', text: '原子性' }, { letter: 'B', text: '一致性' },
          { letter: 'C', text: '隔离性' }, { letter: 'D', text: '持久性' }
        ],
        answer: 'ABCD', analysis: 'ACID 即原子性、一致性、隔离性、持久性。'
      },

      // 不定项（答案 1～多个；全对满分、少选半分、错选 0 分）
      {
        type: 'indefinite', question: '下列关于 HTTP 缓存的说法，正确的有？',
        options: [
          { letter: 'A', text: 'Cache-Control 可指定 max-age 缓存有效期' },
          { letter: 'B', text: 'ETag 用于条件请求校验资源是否变化' },
          { letter: 'C', text: '设置了缓存就不会再向服务器发任何请求' },
          { letter: 'D', text: 'no-store 表示完全不缓存响应' }
        ],
        answer: 'ABD', analysis: '过期后可用 ETag/Last-Modified 发条件请求，C 错误；其余三项正确。'
      },
      {
        type: 'indefinite', question: '下列 Python 对象中，属于可变对象的有？',
        options: [
          { letter: 'A', text: 'list 列表' },
          { letter: 'B', text: 'dict 字典' },
          { letter: 'C', text: 'tuple 元组' },
          { letter: 'D', text: 'str 字符串' }
        ],
        answer: 'AB', analysis: '列表与字典可变；元组、字符串是不可变对象。'
      },
      {
        type: 'indefinite', question: '关于关系型数据库索引，正确的说法有？',
        options: [
          { letter: 'A', text: '索引能加快多数查询的检索速度' },
          { letter: 'B', text: '索引会占用额外存储空间' },
          { letter: 'C', text: '索引越多写入一定越快' },
          { letter: 'D', text: '唯一索引可约束列值不重复' }
        ],
        answer: 'ABD', analysis: '索引会降低写入性能（需同步维护），C 错误；其余正确。'
      },

      // 填空题
      {
        type: 'fill', question: 'Python 中用于定义函数的关键字是 ______。',
        blanks: [{ answer: 'def', hint: '3 个字母' }], analysis: 'def 是定义函数的标准关键字。'
      },
      {
        type: 'fill', question: '监督学习中数据通常分为 ______ 和 ______ 两部分。',
        blanks: [
          { answer: '训练集', hint: '用于训练模型' },
          { answer: '测试集', hint: '用于评估模型' }
        ],
        analysis: '常见划分为训练集与测试集。'
      },
      {
        type: 'fill', question: 'SQL 中用于查询数据的关键字是 ______。',
        blanks: [{ answer: 'SELECT', hint: '查询语句的开头' }], analysis: 'SELECT 用于查询。'
      },

      // 简答题
      {
        type: 'essay', question: '请简述列表与元组的主要区别。',
        reference_answer: '1. 列表可变、元组不可变；2. 列表用 []、元组用 ()；3. 元组可作为字典键而列表不行。',
        analysis: '核心区别在于可变性与使用场景。'
      },
      {
        type: 'essay', question: '数据清洗的主要步骤有哪些？请至少列出 4 个。',
        reference_answer: '缺失值处理、异常值检测与处理、重复数据删除、数据类型转换、数据标准化等。',
        analysis: '数据清洗是数据预处理的重要环节。'
      },
      {
        type: 'essay', question: '简述事务的 ACID 四个特性。',
        reference_answer: '原子性(Atomicity)：要么全做要么全不做；一致性(Consistency)：状态合法；隔离性(Isolation)：并发互不干扰；持久性(Durability)：提交后永久保存。',
        analysis: 'ACID 是事务的基本保证。'
      }
    ]
  };
})(window);