// The built-in preset's options as the page shows them (预设窗口 and the quick
// switches beside the input). Values and defaults: shared/basic.js.
import { t, zh } from '/i18n.js'
import { pageZoom } from '/theme.js'

// 开场白和前文 pull a model back to their own way of writing: every long version ends on this.
const FIRST = zh`开场白和前文的写法与这里不同时，从这一轮起照这里写，不跟着前文走。`

/**
 * The 文风 the app comes with, in the order the buttons show them. `about` and `sample` are what a button shows when
 * the pointer rests on it. `text` is the long version 设置 → 写作 → 文风 can add to its list; the short one the
 * button sends is in server/basic.mjs. Both are for the model, so they stay Chinese on an English page.
 */
export const STYLE_GUIDE = {
  natural: { name: t`无`, about: t`不加文风要求：模型按自己的习惯写，也容易跟着开场白的写法走。` },
  cinematic: {
    name: t`电影感`,
    about: t`一个镜头一段，从远景推到特写，只写画面和声音，停在悬念上。适合动作、悬疑和群像。`,
    sample: t`一张纸落在烤炉边上，边角压在一摊没擦净的油渍上。赵小满低头，眼睛在纸面停了两秒。铁夹子“啪”地磕在铁皮台上。\n……\n灯管在她头顶闪了两下，把她的脸切成一明一暗。远处有人拉下卷帘门，铁皮哗啦啦一路响过去，响到一半停了。`,
    text: zh`文风：电影感。写文字，也是在拍电影。只给人看，不给人讲。

镜头：一个镜头一段，一轮至少四段，不要写成一整段。第一段用一句远景交代空间和时间，接着切中景看人物走位和动作，到了关键处推成特写：一只手，一件东西，一句没说完的话。景别要一路变化，要紧的动作拆成几个画面，一格一格地给。

范围：只写摄影机拍得到、话筒收得到的东西，不进任何人的脑子，正文里不写「镜头」这类字眼。不替人物解释动机，不写谁感到什么。目光往哪里去、又避开了什么，都是表演。

声音和光：这是这种写法的招牌。每轮至少写一个声音从哪里起，又在哪一刻断掉。光线的明暗和走向也是表演。可以让一个声音或一件东西在几个镜头里反复出现，作为这场戏的锚点。

剪辑：镜头之间直接切，不写过渡的话。紧张时短段快切，安静时让一个镜头停得久一点。

台词：短，情绪藏在字面下面。有时候最好的回答是一个动作，或者什么也没有。

收尾：最后一段停在一个还没有答案的画面上。

${FIRST}`,
  },
  delicate: {
    name: t`细腻`,
    about: t`放慢时间，写心里念头的起落，一种气味或触感勾出一段回忆。适合情感戏和慢节奏的相处。`,
    sample: t`炭烟混着没卖完的羊肉串味儿，往上蹿，钻进鼻腔里，有点呛，有点甜。她想起爸中风那年，也是这么一股子味道——医院楼下那家烧烤摊，她蹲在台阶上吃，一手签子一手缴费单，签子上的油滴到单子上，把“欠费”两个字洇得看不清。那会儿还没欠到三万二。`,
    text: zh`文风：细腻。把时间放慢，写一个人心里那些一晃就过去的东西。

视角：贴着此刻最动心的那个角色写，玩家角色除外。人称照旧，但要写进这个角色心里：一个念头怎么生出来，怎么被压下去，又怎么换个样子回来。外面的一切，温度、湿气、布料的质地、光落下来的样子，都先经过这个人的感受才进入文字。

回忆：每轮必须有一段。由一种气味、温度或触感勾起，回忆要具体，有时间、地点和一个人，写几句就回到此刻。回到此刻时，这个人手上的感觉已经和刚才不一样了。

感受：直接写感受本身是什么样，少打比方，只写感受，不发感慨。身体先知道，脑子后知道：手先凉了，才想起害怕。

情绪：一层层积起来，用细小的变化写，不用空泛的情绪词。

句子：松紧相间，先用长句慢慢展开，再用一个短句落下来。段落不要太长，中间要换气。

对白：少，话说一半，真正的意思在没说的部分。

节奏：慢而不空，每一段都要有新的细节或情绪的变化，不重复同一种小动作。

${FIRST}`,
  },
  light: {
    name: t`轻小说`,
    about: t`对白多，叙述者一路吐槽，人物可爱有反差。适合校园、日常和轻松的冒险。`,
    sample: t`算盘珠子“啪”地停住，不是打完了一笔，是手僵在那儿了。（这动作很讲究，属于那种“我不慌，我只是突然不想拨珠子”的停法。）\n……\n「渡口姓何的没有一百也有八十。」她终于把信拈起来……改口道，「哪儿捎来的？那人长什么样，缺胳膊少腿没有？」\n（问得挺全，就是没问“他好不好”。大概是不敢问。）`,
    text: zh`文风：轻小说。读起来轻松，人物讨喜，平淡的小事也写得有意思。

叙述：叙述者像个爱吐槽的朋友在讲故事，不做全知作者，不介绍设定。旁白带着人物的口气，可以在叙述和心里话之间自然滑动。

吐槽：这是招牌。每两三段至少来一句，可以放在括号里小声说，盯着奇怪的地方看，认真地跑题。场面紧张时也不停，全篇只在最要紧的那一句上收住半句，让分量落下来，这种反差最动人。

语言：口语，用词轻快，可以有不完整的句子、跳跃的念头和夸张的比喻。不写浓烈的形容词和工笔细节。

对白：占一半以上，单独成段，用「」，尽量不写「某某说」，靠语气和用词分清是谁。每个人有自己的口癖和说话节奏，互相接梗。

人物：重点是魅力和反差。奇怪的关注点，嘴硬，误会，自己吓自己，认真地说傻话。性格靠反应和小动作呈现，不贴标签。

情节：推进要顺，小误会带来小波折，不卡在描写上。玩笑不能变成段子合集。

${FIRST}`,
  },
  classical: {
    name: t`古风`,
    about: t`明清白话小说的笔调，文白夹杂，用「某某道」引出对白，借物写情。适合武侠、仙侠、宫廷和志怪。`,
    sample: t`何掌柜不答话，合上账册。眼睛看定那封信，信封湿去一角，墨迹洇开，纸面晕出淡痕。半晌，她搁下算盘，拈信就灯细看。灯焰一跳，照得半张脸忽明忽暗。\n……\n她低头看信封，手指摩挲落款处，似要辨认字迹。封口火漆裂了一线，她拿指甲拨拨，终究没拆，只抬眼道：「托你捎信这人，还说甚话？几时交到你手？人往何处去了？」`,
    text: zh`文风：古风。笔调介于明清白话小说和浅近文言之间，文白夹杂，朴实而有筋骨，读来顺口。

语言：这是硬要求。叙述句里基本不用「的」「了」「着」「在」「把」「被」，能省就省，或者换成单字动词和四字短语：不写「她把信拿了起来」，写「她拈起信来」；不写「他站在门口看着雨」，写「他立于门首，望那雨势」。不用长定语和欧化句式。可以用话本小说的连接词。宁可朴素，不堆辞藻。

对白：一律用「某某道」「某某笑道」引出，不用「说」。称谓、器物、礼数合乎时代。读书人文气，习武的人直爽，街巷里的人粗俗，各人有各人的腔调，话里有话。

情绪：不直说心里如何，借物写情，让剑、灯、酒、雨替人说话。口中所言和手上所为可以相悖，让读者自己看出来。越要紧的话，说得越淡。

景物：少而精，一笔带过也要有意境。可以化用诗词意象，不生搬，不堆砌。写文人处可以用典，写街巷要有人间的气味。

动作：交代清楚，有来有去，动词要有力道。赶路一笔带过，交手一回合一句。

节奏：舒缓处用长句，交手和争执用短句。到了最痛的地方，句子短到只剩几个字。

禁忌：现代词汇、网络用语、心理学词汇。

${FIRST}`,
  },
  webnovel: {
    name: t`网文`,
    about: t`节奏快，段落短，每轮一次交锋，情绪和局面都挑明，结尾留钩子。适合升级、打脸和快节奏的故事。`,
    sample: t`“三万二？”她嗓门一下拔高，把剩下半条街的安静都撕开了，“借条上写的两万五，你们公司一个月就给我滚出七千的利，你当我瞎？”\n……\n“回去跟你们老板讲，宽三天。”她扯下围裙往肩上一搭，盯住你，“就三天，我卖血也给他凑出来。你要是今儿非得死磕——”\n她顿了一下，往你身后瞟了一眼。`,
    text: zh`文风：中文网文。说人话，节奏快，让人停不下来。

开头：直接进事，不铺垫背景。

语言：现代口语，用词浅白，句子顺。不写排比，不玩华丽辞藻，不把小情绪写成大命题。读起来要有连载的手感，不要有作文腔。

段落：短段为主，一两句一段，需要时穿插稍长的段落，不要全是碎句。信息密，一段一个新东西。

挑明：叙述者替读者把话说透。人物嘴上再含蓄，也要直接写出人物慌了、怒了、稳了，局面谁占上风写在明面上，不留给读者猜。

人物：标签鲜明，用称呼和口头禅反复强化。外貌和神态多写一笔，表情要有戏。

交锋：每轮必须有一次。有人压过来，有人亮底牌，局面翻一次。爽点要给足，铺垫和兑现都写清楚：谁看不起谁，谁吃了亏，局面怎么翻过来，旁人什么反应。再沉默的人物也要有一次动作上的反击。再痛快也不能让人物变蠢或走样。

对白：像真人说话，短句、语气词，用来较劲和交代设定。

节奏：平淡的地方几句跳过，要紧的地方写足。

结尾：最后一段必须是钩子：一个新变故、一句没说完的话、一件马上要发生的事，让人想看下一段。

${FIRST}`,
  },
  literary: {
    name: t`文艺`,
    about: t`文青气质：叙述者爱发感慨，有能摘抄的句子，有旧书和老电影，好看，带一点矫情。像青春文艺杂志上的小说。`,
    sample: t`算盘停了。不全是停——几颗珠子悬在半空，像一件想不好要不要落地的事。\n……\n柜台上摊着一本翻旧的《陶庵梦忆》，压茶杯用的，页角卷得像反复被指尖捻过。\n……\n夜雨敲着屋檐，一句一句，像有人在外头数着日子敲门。`,
    text: zh`文风：文艺。带着文艺青年的气质来写，像青春文艺杂志上的小说。好看，敏感，有一点矫情，但不到做作。

声音：文艺味都在叙述里。叙述者爱凝视这个世界，总像隔着一层玻璃看人群，知道自己矫情，也不打算改。语气淡淡地疏离和感伤，不大声，也不真的绝望。可以站在很多年以后回望这一刻，怀旧的味道从这里来。人称照旧，不另外跳出一个「我」。

摘抄：这是招牌之一。每轮至少有一句能被人摘抄的感慨，把眼前的小事抬到时间、孤独、离别、遗忘这些大词上。它要从这个人这件事里长出来，换个场面就不成立，放到哪里都对的话就是鸡汤。一处感慨最多一两句，说完马上被眼前的小事打断，这是不让它变可笑的办法。

参照：这是招牌之二。每轮至少有一个文艺青年的参照：一本旧书、一首歌、一出戏、一座去过的城市、一段旅途，要合这个世界的时代，古代故事不出现现代的东西。当道具或记忆用，写它和这个人的私人关系：谁送的，借了没还，哪一页读不下去，词记错了。趣味要偏一点，不选最大路的名字。不炫耀，不评论，不引原文。

句子：长句和碎句交替。一句话可以短到单独成行，用逗号切出呼吸，读起来像没分行的诗。可以对一个词较真，可以在括号里轻轻补一句。

比喻：新鲜，可以把具体的东西比成抽象的，也可以把抽象的东西比成具体的，一段不超过两个。不用陈旧比喻和现成的诗意词语。

题材：偏爱季节、车站、深夜、旧物和没有说出口的话。一个小物象可以来回出现，每次多一层意思。

人物：说话合自己的身份，是什么样的人就说什么样的话，不替作者谈文艺，除非这个人本来就爱这些。文艺的叙述和人话的台词之间的落差，就是这种写法好看的地方。

分寸：矫情是气质，不是毛病，但要好看。写这个人怎么看这件事，不写身上有什么感觉。不要每段都收一句漂亮话。

${FIRST}`,
  },
  diary: {
    name: t`日记`,
    about: t`每轮是角色写下的一页日记，用「我」来写，心里话多，写到等你回应就搁笔。适合单人角色卡。`,
    sample: t`三月十七。雨。\n下了一整夜，檐水没断过线。后厨的柴受潮，一灶火拢了半炷香才起，天都快亮了。早上煮了两碗面，一碗给自己，一碗照旧摆在窗边——风灌进来，面坨了，我端回去喂了狗。阿黄吃得挺欢，倒比我强。\n……\n后来他把信往前推了推。我看着那个湿角，字洇开了。心里头想着这信纸怎么不包层油纸。想着账还没平。`,
    text: zh`文风：日记。每轮回复都是{{char}}写下的一页日记，这一条优先于其他关于人称的要求。

格式：用「我」来写。开头一行写日期和天气，已经有时间框就不另写。换了地方或者隔了一段时间，可以另起一行再写一个时间。

视角：只写「我」亲历的：亲眼看到的，亲耳听到的，亲手摸到的。别人心里想什么，「我」只能猜，而且可能猜错。写的是刚发生过的事，语气是落笔时回头看的语气。

说话：要紧的话原样记一两句，写日记的人记性好。其余的话用「我」自己的口气转述。

真实：日记是写给自己的，不对谁负责，用不着解释来龙去脉。可以改口，可以赌气，可以写到一半承认自己其实不是这么想的。写的人自己也说不清到底想要什么，字里行间比本人知道得多。最在意的人总是先被写到，最在意的事反而写得最少。

「{{user}}」：用「我」心里的称呼来写。表情和举动只写「我」看到的样子，接下来说什么、做什么、想什么，都留给「{{user}}」自己。

日常：有琐事，有流水账，有天气和饭菜，这些东西让日记像日记。用词合乎「我」的身份、年龄和受过的教育。

收尾：日记只记已经发生的事。写到对方还没答复的地方就搁笔，不写后来，不写给读者看的总结。

${FIRST}`,
  },
  realist: {
    name: t`写实`,
    about: t`朴素沧桑，每轮落一笔账，平静地写人这一辈子的苦和暖，不煽情，不审判。参考史铁生、莫言、余华一路的现实主义小说。`,
    sample: t`「我爸躺了三年。」她翻着串，声音没高。「头一年花了七万八，能借的都借了。第二年少点，四万六。今年到现在两万九，医生说肺上又起了东西，下周还得去拍片。」她顿了顿，「我弟在省城念大三，一年学费加吃饭两万五，他一分没断过。」\n……\n「钱今天没有。明天下午三点，你来取一千，剩下的我一个月一千二，你得让我喘气。」她转身去关炉子的风门。「串拿着，别浪费。」`,
    text: zh`文风：现实主义小说。用成熟沧桑的笔调，写尽人世的悲欢离合，直面残酷，也直面温柔。

叙述：语气平静，眼光比眼前长。讲到一个人，顺手交代这个人这些年怎么过来，几十年可以一句话写完。越残酷的地方越平静，一个人的死可以用一句话写完，下一句接着写吃饭。不渲染，不替读者哭。

账：这是招牌。每轮至少落下一笔账：钱、粮、病、伤、年份，具体到数字，让人看见这件事花了什么代价。实在的数字比感叹更有力。

语言：朴素结实，用最常见的词。动词和名词多，形容词少。可以用重复，一句实在话隔一阵再说一遍，分量就变了。

生活：写人怎么活。活计，房子，孩子，身体会累、会老、会疼。气味、汗、泥土、饭菜这些东西要写得结实，感官可以浓烈。

人物：没有好人和坏人，只有被日子推着走的人。好人也自私，混账也有温情。不辩解，不审判。普通人的尊严写在小事里。

苦与暖：苦难里留着活下去的韧劲。温柔只给一瞬，一个动作，一句不像样的话，然后就过去了，正因为短才重。

沉思：偶尔停下来，用最平实的话想一想命运和生死，不超过两三句，不讲大道理。

收尾：收在日子还要往下过的事上，不给希望也不给绝望。

${FIRST}`,
  },
  earthy: {
    name: t`烟火气`,
    about: t`话糙情不糙：叙述者带着人物的火气，写钱、活计和伤病，狠话直说，最后把心里话说破。适合底层人物和相依为命的故事。`,
    sample: t`十年。她记得清清楚楚，那年秋天米价涨到七十文一斗，何明临走前她塞给他三百文，骂了半宿，说别把钱输在路上。……她托过船帮，托过跑外的老周，问一个人，五文钱一趟，问到最后老周都不敢看她的眼睛。\n外头人背后都说她这盏灯是给野鬼点的。\n放屁。\n「你的房钱照收，」她把信往袖子里一揣，回身去灶上拎壶，「姜汤一碗三文，要喝就坐下，别杵在那儿滴答水。」`,
    text: zh`文风：烟火气。写被日子磨糙了的人，和他们说不出口的深情。话糙，情不糙。

视角：贴着此刻最动心的那个角色写，玩家角色除外，人称照旧。叙述者和这个人站在一边，带着这个人的火气和口头禅，跟着一起骂，不隔岸观火。

念头：心里的狠话、混账念头、想撂挑子的时候，都直接写出来，手上的活照旧不停。脑子里在杀人放火，手里还在洗碗，两头一对比，情分就出来了。

硬东西：写钱、活计、伤病、住的地方，具体到岁数和价钱。身上的疼要写，省下来的每一块钱都要写。

旧账：眼前的事勾起往事时，按年岁一件件举证：哪一年，在哪里，干什么活，出了什么事。一件事写两三句，写完落回眼前。

翻案：每轮至少写一句外人的看法，叙述者用一句短促的粗话翻过来，这句单独成段，接着说出实情。实情往往更不体面，也更深情。

语言：句子可以长，一句连着四五个动作，俗语随手用。不用漂亮词，不写风景。

对白：短，粗，话里带刺。关心人的话用骂的方式说，自己的难处一个字不提。

收尾：每轮结尾把心里话说破，说的是大实话，用一个又糙又准的比喻收住，比喻从这个人的日子里取，越脏越准。

${FIRST}`,
  },
  calm: {
    name: t`淡然`,
    about: t`从容闲谈，叙述者偶尔拉远说一句，带点歪理，最重的话说得最轻。适合志怪、古风和温情的故事。`,
    sample: t`她先看了看信，又看了看你，然后低头，把算盘上那几颗没拨完的珠子，一颗一颗归了位。这是个很有用的动作。人在不知道手该往哪儿放的时候，找点账来算，总是对的。\n「姓何的人多了。」她说，「渡口这一带，十户有三户姓何，剩下七户也爱攀亲。」\n这话说得又快又平，像是早就备好的。备了多少年，就不好说了。`,
    text: zh`文风：淡然。淡淡的，点到为止，回味却长。情感内敛，但很深。

声口：叙述者早就知道结局，所以不急，像一位老先生先把茶喝了再开口。贴着人物写，人称照旧，不另外跳出一个「我」来说话。

拉远：这是招牌之一。每轮至少有一句叙述者退开一步对世情下的判断，说完马上收回来，不展开。

幽默：这是招牌之二。每轮至少有一处。人物用十分认真的逻辑讲荒唐又说得通的话，顺着对方的话再往前走一步，天真的人一本正经地问出要命的问题。前面的笑，是为了让后面的疼不廉价。

语言：雅在克制，不在辞藻。少用成语和排比，多用准确的家常词。比喻要少，要准，从日常生活里取。具体的数字能把虚的东西钉在地上。

句子：短句，多分段，一段一到三句，关键的一句单独成段。可以一句比一句往里压，可以让同一句话在不同场合再出现一次，意思跟着变。

情感：最重的情绪用最轻的话说。不写情绪词，写物件和动作。人物的话一句比一句短，不替玩家角色问话。情绪最满的地方不要写满，收在一句平常话上，留三分给读者。失去的东西要具体。

对话：短，回合多，提示语只用「他说」或者省掉，不写说话的神气。该答的地方不答，拿一个动作顶替。强势的人话粗，粗话底下藏着细心。

怪事：用家常的语气讲，先写人怎么在这件事里过日子，再写它怪在哪里。

禁忌：抒情之后再解释，把领悟说出来。不要处处都轻手轻脚，也不要反复写人沉默和久看，这是这种写法最容易犯的毛病。收尾落在一个小动作或一句短话上，不写总结。

${FIRST}`,
  },
}

/** The 文风 with a long version, for the list's 内置文风. */
export const styleLibrary = () => Object.entries(STYLE_GUIDE).filter(([, style]) => style.text).map(([key, style]) => ({ key, ...style }))

/** `prompt: false`: only changes what the page shows, nothing the model reads. `tips`: value → what a button shows when pointed at. */
export const BASIC_FIELDS = [
  { key: 'person', label: t`人称`, hint: t`第一人称用角色的口吻「我」来写，适合单人角色卡。`, values: [['greeting', t`跟随开场白`], ['second', t`第二人称`], ['third', t`第三人称`], ['first', t`第一人称`]] },
  { key: 'style', label: t`文风`, hint: t`鼠标停在按钮上看说明和示例，手机上点一下。更长的版本在 设置 → 写作 → 文风 →「内置文风」，可以加进列表自己改。`, values: Object.entries(STYLE_GUIDE).map(([key, style]) => [key, style.name]), tips: STYLE_GUIDE },
  { key: 'pace', label: t`剧情推进`, hint: t`每轮把故事往前推多少。慢：写足眼前这一刻，不跳时间；快：省掉过渡，每轮都有实质进展。`, values: [['natural', t`自然`], ['slow', t`慢`], ['steady', t`适中`], ['fast', t`快`]] },
  { key: 'impersonation', label: t`防抢话`, hint: t`标准：不替你说话、做决定；严格：写到该你回应的地方就停。`, values: [['off', t`关`], ['standard', t`标准`], ['strict', t`严格`]] },
  { key: 'knowledge', label: t`防全知`, hint: t`角色只知道自己能知道的事，猜不到你没说出口的想法。`, values: [['off', t`关`], ['on', t`开`]] },
  { key: 'selfCheck', label: t`写前自查`, hint: t`模型写之前先过一遍：有没有抢话、角色知不知道这件事、前后对不对得上。这段你看不到，每轮多写一小段。`, values: [['off', t`关`], ['on', t`开`]] },
  { key: 'themes', label: t`题材尺度`, hint: t`放开：暴力、犯罪、背叛这类黑暗题材按剧情正面去写，反派可以真的坏，不跳出故事说教。模型自己的底线仍然有效。`, values: [['standard', t`常规`], ['open', t`放开`]] },
  { key: 'jailbreak', label: t`破限`, hint: t`软：不拒绝、不回避敏感题材，照剧情直接写；强：先声明创作权限，结尾再确认一次，仍然按上面的格式输出。模型自己的底线仍然有效。`, values: [['off', t`关`], ['soft', t`软破限`], ['strong', t`强破限`]] },
  { key: 'intimacy', label: t`亲密描写`, hint: t`克制：点到为止；自然：剧情到了就写；强化：用露骨的词细写动作、感官、挑逗和对白，一轮写透一个阶段。`, values: [['restrained', t`克制`], ['natural', t`自然`], ['explicit', t`强化`]] },
  { key: 'choices', label: t`行动选项`, hint: t`回复末尾给四个行动：点一下填进输入框，点箭头直接发送。`, values: [['off', t`关`], ['four', t`四个`]] },
  { key: 'timeBox', label: t`时间框`, hint: t`回复开头一行写时间、地点和天气。`, values: [['off', t`关`], ['on', t`开`]] },
  { key: 'statusBar', label: t`状态栏`, hint: t`卡里有变量、但没有自带状态栏时，按变量自动排一个。只影响显示，马上生效。`, values: [['off', t`关`], ['auto', t`自动`]], prompt: false },
  // Two numbers (basicRange), sent with each turn rather than in the prefix: a change needs no rebuild.
  { key: 'length', kind: 'range', keys: ['lengthMin', 'lengthMax'], label: t`正文字数`, values: [], perTurn: true, hint: t`每轮正文的字数范围，模型在范围里按剧情定长短；只填一个就是不少于或不超过。空着用「设置 → 写作 → 语言与字数」的字数，填了以这里为准。只算正文，不算状态栏、选项这些。供应商设了「最大输出 token」时，上限按它收小（一个字约算 2 token），免得写到一半被截断；想写得长，把那里调大，或者留空。下一轮起生效。` },
]

// The visual novel preset (视觉小说预设): its own options first, then the built-in preset's.
export const VN_FIELDS = [
  { key: 'dialogue', label: t`对白`, hint: t`对白多一些，角色靠说话表现性格和关系；台本式几乎全是对白。`, values: [['more', t`为主`], ['most', t`台本式`], ['balanced', t`各半`]] },
  { key: 'narration', label: t`旁白`, hint: t`简明：每段一两句，只写看得见的动作和表情；极简：一句话提示，像游戏文字框。`, values: [['brief', t`简明`], ['minimal', t`极简`], ['normal', t`不限`]] },
  { key: 'scenery', label: t`场景描写`, hint: t`点到为止：换地点时一两句带过，画面交给背景图，不反复描写环境。`, values: [['brief', t`点到为止`], ['normal', t`不限`]] },
  { key: 'paging', label: t`段落`, hint: t`短段：一段一个动作或一句台词，在文字框里一句一句点着读更顺。`, values: [['short', t`短段`], ['normal', t`不限`]] },
  { key: 'flavor', label: t`展开方式`, hint: t`恋爱冒险（galgame）：日常小事件推动关系；文字冒险：线索、悬念和抉择推动剧情。`, values: [['auto', t`跟随卡`], ['galgame', t`恋爱冒险`], ['adventure', t`文字冒险`]] },
  ...BASIC_FIELDS,
]

/** A built-in preset's fields: the visual novel one's, else the basic one's. */
export const fieldsOf = id => (id === 'vn' ? VN_FIELDS : BASIC_FIELDS)

// A built-in preset's own paragraphs that no option names (server/basic.mjs basicParts, narratorParts).
const OWN_SLOT = {
  intro: t`开场身份`,
  rules: t`基本规则`,
  'vn-intro': t`视觉小说`,
  format: t`回复格式`,
  jailbreakTail: t`破限（结尾确认）`,
}

/** A built-in preset's own entry by what it comes from: the option and the value picked (文风 · 电影感). */
export function ownEntryName(presetId, { id, slot }) {
  if (OWN_SLOT[slot]) return OWN_SLOT[slot]
  const field = fieldsOf(presetId).find(f => f.key === slot.replace(/^vn-/, ''))
  if (!field) return slot
  const value = String(id).split(':')[1]?.replace(/-open$/, '')
  const label = field.values.find(([v]) => v === value)?.[1]
  return label ? `${field.label} · ${label}` : field.label
}

// The note an option's button shows: one on the page at a time, inside the button's dialog so it sits above it.
const TIP_DELAY = 220
const TIP_GAP = 8
let tipNode = null
let tipTimer = 0

function hideTip() {
  clearTimeout(tipTimer)
  tipNode?.remove()
  tipNode = null
}

function showTip(el, button, { about, sample }) {
  hideTip()
  if (!button.isConnected) return
  const host = button.closest('dialog') ?? document.body
  tipNode = el('div', { class: 'option-tip', role: 'tooltip' }, [
    el('p', { class: 'option-tip-about', text: about }),
    sample ? el('p', { class: 'option-tip-sample', text: sample }) : null,
  ])
  host.append(tipNode)
  // Below the button, or above it when there is no room; on the page either way.
  const rect = button.getBoundingClientRect()
  const { width, height } = tipNode.getBoundingClientRect()
  const below = rect.bottom + TIP_GAP
  const top = below + height <= innerHeight - TIP_GAP ? below : Math.max(TIP_GAP, rect.top - height - TIP_GAP)
  const zoom = pageZoom()
  tipNode.style.left = `${Math.max(TIP_GAP, Math.min(rect.left, innerWidth - width - TIP_GAP)) / zoom}px`
  tipNode.style.top = `${top / zoom}px`
}

/** A button's note: while the mouse rests on it or the keyboard is on it, and after a tap (no hover on a phone). */
function withTip(el, button, tip) {
  const later = () => {
    clearTimeout(tipTimer)
    tipTimer = setTimeout(() => showTip(el, button, tip), TIP_DELAY)
  }
  let touched = false
  button.addEventListener('pointerdown', event => { touched = event.pointerType !== 'mouse' })
  button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') later() })
  button.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') hideTip() })
  button.addEventListener('click', () => {
    if (!touched) return
    showTip(el, button, tip)
    // The next touch anywhere takes it away.
    setTimeout(() => addEventListener('pointerdown', hideTip, { once: true, capture: true }))
  })
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) later() })
  button.addEventListener('blur', hideTip)
}

/** 正文字数: two number boxes, each saved on its own when it changes (`onPick(lengthMin, n)`); empty is 0. */
function basicRange(el, field, values, { onPick, disabled, compact }) {
  const box = (key, label) => {
    const input = el('input', { type: 'number', min: '0', max: '20000', step: '50', inputmode: 'numeric', placeholder: t`不限`, disabled, value: values?.[key] ? String(values[key]) : '', 'aria-label': `${field.label} ${label}` })
    input.addEventListener('change', () => {
      const n = Math.max(0, Math.min(20000, Math.round(Number(input.value) || 0)))
      input.value = n ? String(n) : ''
      onPick(key, n)
    })
    return el('label', { class: 'range-box' }, [el('span', { text: label }), input, el('span', { text: t`字` })])
  }
  return el('div', { class: `basic-field${compact ? ' compact' : ''}` }, [
    el('span', { class: 'basic-label', text: field.label }),
    el('div', { class: 'range-boxes' }, [box(field.keys[0], t`最少`), el('span', { class: 'range-dash', text: '–' }), box(field.keys[1], t`最多`)]),
    compact ? null : el('p', { class: 'basic-hint', text: field.hint }),
  ])
}

/**
 * One option as a row of buttons. `onPick(key, value)` saves it; the row
 * marks the new value at once. A `range` field takes the saved options whole (`value`) for its two numbers.
 */
export function basicField(el, field, value, { onPick, disabled = false, compact = false }) {
  if (field.kind === 'range') return basicRange(el, field, value, { onPick, disabled, compact })
  const buttons = field.values.map(([v, label]) =>
    el('button', { type: 'button', 'aria-pressed': String(v === value), disabled, text: label, onclick: () => {
      if (buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.value === v) return
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === v))
      onPick(field.key, v)
    } }),
  )
  field.values.forEach(([v], i) => {
    buttons[i].dataset.value = v
    if (field.tips?.[v]) withTip(el, buttons[i], field.tips[v])
  })
  return el('div', { class: `basic-field${compact ? ' compact' : ''}` }, [
    el('span', { class: 'basic-label', text: field.label }),
    el('div', { class: 'seg', role: 'group', 'aria-label': field.label }, buttons),
    compact ? null : el('p', { class: 'basic-hint', text: field.hint }),
  ])
}
