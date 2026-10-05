import Helper from '@ember/component/helper';
import {htmlSafe} from '@ember/template';
import {inject} from 'ghost-admin/decorators/inject';

export default class SiteIconStyleHelper extends Helper {
    @inject config;

    compute() {
        const icon = this.config.icon || '/ghost/assets/icons/ghost-orb.svg';
        return htmlSafe(`background-image: url(${icon})`);
    }
}
